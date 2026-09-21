import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { Vm } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { toast } from 'sonner'
import { fmtBytes } from '@/lib/format'
import { wrapSyncKernelFails } from '@/lib/wrap-health'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { CircularProgress } from '@/components/ui/circular-progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { CardGridSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { StatusMark } from '@/components/status-mark'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  inferenceEngineLabel,
  normalizeInferenceEngine,
} from '@/features/vm/engine-contract'
import {
  KernelPipeline,
  type Station,
  type StationId,
} from '@/features/wrap/kernel-pipeline'
import {
  makeWrapSample,
  promoteWrapSample,
  repairWrapSample,
  syncWrapSample,
  uploadKernelBinary,
  wrapSampleQueryOptions,
  type WrapKernelPayload,
  type WrapSample,
  type WrapSyncReport,
} from '@/features/wrap/queries'

const MAX_KERNEL_UPLOAD_BYTES = 32 * 1024 * 1024

const TONE_OK: StatusTone = { key: 'ok', cls: 'ok', text: '就绪' }
const TONE_NONE: StatusTone = { key: 'none', cls: 'none', text: '未知' }

function sampleDirLabel(dir?: string) {
  if (!dir) return 'share/wrap-cli'
  const parts = dir.replace(/\\/g, '/').split('/')
  const i = parts.lastIndexOf('share')
  if (i >= 0) return parts.slice(i).join('/')
  return parts.slice(-2).join('/')
}

function kernelPathLabel(p?: string) {
  if (!p) return '—'
  const parts = p.replace(/\\/g, '/').split('/')
  const i = Math.max(parts.lastIndexOf('bin'), parts.lastIndexOf('wrap-cli'))
  if (i >= 0) return parts.slice(i).join('/')
  return parts.slice(-2).join('/')
}

const KERNEL_SOURCE_LABEL: Record<string, string> = {
  configured: '仓内最新 kernel',
  sample: '母样本 kernel',
  missing: '未找到 kernel',
}

function osOf(vm: Vm) {
  const runtime = vm.runtime && typeof vm.runtime === 'object' ? vm.runtime : {}
  const os = String(runtime.os || runtime.image || vm.kernel || '').trim()
  return os || '—'
}

function engineOf(vm: Vm) {
  return vm.resolved_inference_engine || vm.inference_engine || 'auto'
}

function toastSync(report: WrapSyncReport) {
  const total = report.total ?? 0
  const ok = report.ok_count ?? 0
  const failed = report.failed_count ?? 0
  const kernelFail = wrapSyncKernelFails(report.items)
  if (failed > 0) toast.error(`kernel 重装 ${ok}/${total}`)
  else if (kernelFail > 0)
    toast.error(`kernel 文件 ${ok}/${total}，进程未起来 ${kernelFail}`)
  else toast.success(`kernel 重装 ${ok}/${total}`)
}

/** 上一次同步里这台槽的结果。没跑过同步就没有状态，不要假装成功。 */
function slotSyncTone(
  item?: NonNullable<WrapSyncReport['items']>[number]
): StatusTone | null {
  if (!item) return null
  if (item.ok === false)
    return { key: 'bad', cls: 'bad', text: item.error || '同步失败' }
  if (item.kernel?.ok === false)
    return { key: 'warn', cls: 'warn', text: '文件已写，进程未起' }
  if (item.kernel?.skipped)
    return { key: 'off', cls: 'off', text: '已写文件（未重启）' }
  return { key: 'ok', cls: 'ok', text: '已重装' }
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className='flex items-center justify-between gap-2 text-sm'>
      <span className='text-muted-foreground'>{label}</span>
      {children}
    </div>
  )
}

function Flag({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <Row label={label}>
      <StatusMark
        tone={
          ok
            ? { key: 'ok', cls: 'ok', text: '有' }
            : { key: 'bad', cls: 'bad', text: '缺' }
        }
      />
    </Row>
  )
}

function KernelPayload({ payload }: { payload?: WrapKernelPayload | null }) {
  return (
    <div className='space-y-2 text-sm'>
      <Row label='来源'>
        <span className='font-medium'>
          {KERNEL_SOURCE_LABEL[payload?.source || 'missing'] || '未找到 kernel'}
        </span>
      </Row>
      <Row label='文件'>
        <code className='text-xs'>{kernelPathLabel(payload?.path)}</code>
      </Row>
      <Row label='大小'>
        <span className='font-mono text-xs'>
          {payload?.size ? fmtBytes(payload.size) : '—'}
        </span>
      </Row>
      <Row label='mtime'>
        <span className='font-mono text-xs'>{payload?.mtime || '—'}</span>
      </Row>
    </div>
  )
}

function buildStations(
  data: WrapSample | undefined,
  slots: number,
  synced: number
): Station[] {
  const kernelSource = data?.kernel?.source
  const sampleOk = !!(data?.kernel_bin && data?.wrapper)
  return [
    {
      id: 'image',
      label: '镜像',
      caption: 'bin/ · share/wrap-cli',
      tone: { key: 'ok', cls: 'ok', text: '入口写入' },
    },
    {
      id: 'repo',
      label: '仓内二进制',
      caption: kernelPathLabel(data?.kernel?.path),
      tone:
        kernelSource === 'missing' || !kernelSource
          ? { key: 'bad', cls: 'bad', text: '缺 kernel' }
          : kernelSource === 'sample'
            ? { key: 'warn', cls: 'warn', text: '回落母样本' }
            : TONE_OK,
    },
    {
      id: 'sample',
      label: '母样本',
      caption: sampleDirLabel(data?.dir),
      tone: data?.ok
        ? TONE_OK
        : sampleOk
          ? { key: 'warn', cls: 'warn', text: '缺 shim' }
          : { key: 'bad', cls: 'bad', text: '不完整' },
    },
    {
      id: 'slots',
      label: '槽内 CLI',
      caption: slots ? `${slots} 个槽位` : '还没有槽位',
      tone: !slots
        ? { key: 'none', cls: 'none', text: '无槽位' }
        : synced === 0
          ? TONE_NONE
          : synced >= slots
            ? { key: 'ok', cls: 'ok', text: '本次全部重装' }
            : {
                key: 'caution',
                cls: 'caution',
                text: `本次 ${synced}/${slots}`,
              },
    },
  ]
}

export function WrapSamplePage() {
  const qc = useQueryClient()
  const sample = useQuery(wrapSampleQueryOptions())
  const dash = useQuery(dashboardQueryOptions())
  const vms = useMemo<Vm[]>(() => dash.data?.vms || [], [dash.data])
  const [restart, setRestart] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [promoteId, setPromoteId] = useState<string | null>(null)
  const [makeOpen, setMakeOpen] = useState(false)
  const [glibcVm, setGlibcVm] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [station, setStation] = useState<StationId>('repo')
  const [lastSync, setLastSync] = useState<WrapSyncReport | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const rustVms = useMemo(
    () => vms.filter((vm) => engineOf(vm) === 'rust'),
    [vms]
  )

  const syncById = useMemo(() => {
    const map = new Map<string, NonNullable<WrapSyncReport['items']>[number]>()
    for (const item of lastSync?.items || []) {
      if (item?.id) map.set(item.id, item)
    }
    return map
  }, [lastSync])

  const syncedOk = useMemo(
    () =>
      (lastSync?.items || []).filter(
        (item) => item?.ok !== false && item?.kernel?.ok !== false
      ).length,
    [lastSync]
  )

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: wrapSampleQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }

  const sync = useMutation({
    mutationFn: () =>
      syncWrapSample({
        ids: selected.length ? selected : undefined,
        restart,
      }),
    onSuccess: async (report) => {
      setLastSync(report)
      setStation('slots')
      toastSync(report)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const promote = useMutation({
    mutationFn: (id: string) => promoteWrapSample(id),
    onSuccess: async (_data, id) => {
      toast.success(`已从 ${id} 晋升 wrap 文件`)
      setPromoteId(null)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const make = useMutation({
    mutationFn: () => makeWrapSample({ glibc_vm: glibcVm || undefined }),
    onSuccess: async () => {
      toast.success('已重整 wrap 文件')
      setMakeOpen(false)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const repair = useMutation({
    mutationFn: (id: string) => repairWrapSample(id),
    onSuccess: async (report, id) => {
      const kernelOk = report.kernel?.ok !== false
      toast[kernelOk ? 'success' : 'error'](
        kernelOk ? `${id} 已重装 kernel` : `${id} kernel 文件已写入，进程未起来`
      )
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const upload = useMutation({
    mutationFn: (file: File) => uploadKernelBinary(file),
    onSuccess: async () => {
      toast.success('已替换仓内 kernel，请选择槽位重装')
      setUploadFile(null)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const toggle = (id: string, on: boolean) => {
    setSelected((cur) =>
      on ? Array.from(new Set([...cur, id])) : cur.filter((x) => x !== id)
    )
  }

  const pickKernelFile = (file?: File) => {
    if (!file) return
    if (file.size > MAX_KERNEL_UPLOAD_BYTES) {
      toast.error('kernel 不能超过 32MB')
      return
    }
    if (!file.size) {
      toast.error('kernel 文件为空')
      return
    }
    setUploadFile(file)
  }

  const data = sample.data
  const complete = data?.ok === true
  const busy = sync.isPending || repair.isPending || make.isPending
  const stations = buildStations(data, vms.length, syncedOk)

  return (
    <PageHeader
      title={VIEW_TITLES.wrap}
      extra={
        <div className='flex gap-2'>
          <input
            ref={fileRef}
            type='file'
            className='hidden'
            onChange={(event) => {
              pickKernelFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <Button
            size='sm'
            variant='outline'
            disabled={upload.isPending}
            loading={upload.isPending}
            onClick={() => fileRef.current?.click()}
          >
            上传 kernel
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={make.isPending}
            loading={make.isPending}
            onClick={() => setMakeOpen(true)}
          >
            重整 wrap 文件
          </Button>
          <Button
            size='sm'
            disabled={!complete || sync.isPending}
            loading={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {selected.length
              ? `重装所选 ${selected.length} 槽`
              : '全部重装 kernel'}
          </Button>
        </div>
      }
    >
      <QueryGate
        loading={sample.isLoading || dash.isLoading}
        error={sample.error || dash.error}
        skeleton={
          <CardGridSkeleton cards={2} className='grid gap-4 lg:grid-cols-2' />
        }
      >
        <p className='mb-4 max-w-3xl text-sm leading-relaxed text-muted-foreground'>
          kernel 顺着这条链路走：镜像 → 仓内二进制 → 母样本 → 槽内 CLI。
          重装只换文件和进程，不改凭证、不改 SOCKS、不 docker rm。
        </p>

        <KernelPipeline
          stations={stations}
          active={station}
          onSelect={setStation}
          busy={busy}
          trailing={
            <>
              <CircularProgress
                value={syncedOk}
                max={vms.length || 1}
                size={52}
                label='本次'
                showPercentage={false}
              />
              <div className='min-w-0 text-xs'>
                <p className='font-medium'>
                  {lastSync
                    ? `本次重装 ${syncedOk}/${lastSync.total ?? vms.length}`
                    : '本次还没重装'}
                </p>
                <p className='text-muted-foreground'>
                  {lastSync
                    ? '结果见下方槽位表的「上次结果」列'
                    : '选槽后点右上角重装，结果会写回表里'}
                </p>
              </div>
            </>
          }
        />

        <Card className='mt-4'>
          <CardHeader>
            <CardTitle>
              {station === 'image'
                ? '镜像 — 二进制从哪来'
                : station === 'repo'
                  ? '仓内二进制 — 重装用的就是它'
                  : station === 'sample'
                    ? '母样本 — 铺到槽内的那份'
                    : '槽内 CLI — 谁真正在跑'}
            </CardTitle>
          </CardHeader>
          <CardContent className='text-sm'>
            {station === 'image' ? (
              <div className='grid gap-3 leading-relaxed text-muted-foreground lg:grid-cols-2'>
                <div className='space-y-2'>
                  <p>
                    镜像安装（<code>docker compose pull</code>）下，
                    <code>bin/kin-*</code> 与 <code>share/wrap-cli</code>
                    由镜像入口在每次启动时写入挂载目录；源码模式则用仓内构建产物。
                  </p>
                  <p>
                    下面展示的路径都是<b>控制面容器内</b>
                    路径；宿主上的真实位置由 安装目录决定，不再固定{' '}
                    <code>/opt/vm2api</code>。
                  </p>
                </div>
                <div className='space-y-2 border-l-2 border-[color:var(--status-caution)] pl-3'>
                  <p className='font-medium text-foreground'>
                    升级会覆盖你上传的 kernel
                  </p>
                  <p>
                    「上传 kernel」改的是挂载目录里的文件。下次
                    <code>compose pull</code>{' '}
                    升级后，入口会用新镜像里的版本覆盖它。 要长期固定自编
                    kernel，把它打进镜像或升级后重新上传并重装槽位。
                  </p>
                </div>
              </div>
            ) : null}

            {station === 'repo' ? (
              <div className='grid gap-4 lg:grid-cols-2'>
                <div className='rounded-md border bg-muted/40 p-3'>
                  <KernelPayload payload={data?.kernel} />
                </div>
                <div className='space-y-2 leading-relaxed text-muted-foreground'>
                  <p>
                    默认用仓内 <code>bin/kin-kernel</code>（
                    <code>KIN_KERNEL_BIN</code>）。旧母样本 ELF 不会盖回去；
                    来源显示「母样本 kernel」说明仓内这份缺了，正在回落。
                  </p>
                  <p>
                    「上传 kernel」只替换这份二进制，<b>不会自动同步槽位</b>
                    ，选槽再点重装，运行中的进程才会加载新文件。
                  </p>
                  <Button
                    size='sm'
                    variant='outline'
                    className='cursor-pointer'
                    disabled={upload.isPending}
                    loading={upload.isPending}
                    onClick={() => fileRef.current?.click()}
                  >
                    上传替换
                  </Button>
                </div>
              </div>
            ) : null}

            {station === 'sample' ? (
              <div className='grid gap-4 lg:grid-cols-2'>
                <div className='space-y-2 rounded-md border bg-muted/40 p-3'>
                  <Row label='目录'>
                    <code className='text-xs'>{sampleDirLabel(data?.dir)}</code>
                  </Row>
                  <Flag ok={data?.kernel_bin} label='kernel.bin' />
                  <Flag ok={data?.wrapper} label='kernel wrapper' />
                  <Flag ok={data?.glibc_shim} label='glibc 2.39 shim' />
                </div>
                <div className='space-y-3 leading-relaxed text-muted-foreground'>
                  <p>
                    同步时这份母样本（cli-node / wrapper / shim）会铺到槽内，
                    kernel 则叠上仓内最新那份。三项缺一，重装按钮就不放行。
                  </p>
                  <label className='flex cursor-pointer items-center gap-2 text-foreground'>
                    <Checkbox
                      checked={restart}
                      onCheckedChange={(v) => setRestart(v === true)}
                    />
                    <span>同步后重启 rust kernel（让 CONNECT 桥跟着起来）</span>
                  </label>
                  <Button
                    size='sm'
                    variant='outline'
                    className='cursor-pointer'
                    disabled={make.isPending}
                    loading={make.isPending}
                    onClick={() => setMakeOpen(true)}
                  >
                    重整母样本
                  </Button>
                </div>
              </div>
            ) : null}

            {station === 'slots' ? (
              <div className='space-y-2 leading-relaxed text-muted-foreground'>
                <p>
                  单槽「重装 kernel」只修这一台，不碰凭证；覆盖在跑的文件会先
                  <code>unlink</code> 再换上。
                </p>
                <p>
                  rust cli-hop 槽才会起 wrap kernel；go 槽只收文件，
                  表里标成「只收文件」。
                </p>
                {lastSync ? (
                  <p className='text-foreground'>
                    上次重装：成功 {lastSync.ok_count ?? 0}，失败{' '}
                    {lastSync.failed_count ?? 0}，进程未起{' '}
                    {wrapSyncKernelFails(lastSync.items)}。
                  </p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className='mt-4'>
          <CardHeader className='flex-row items-center justify-between gap-2 space-y-0'>
            <CardTitle>槽位</CardTitle>
            {vms.length ? (
              <div className='flex items-center gap-2'>
                <span className='text-xs text-muted-foreground tabular-nums'>
                  已选 {selected.length}/{vms.length}
                </span>
                <Button
                  size='sm'
                  variant='ghost'
                  className='cursor-pointer'
                  disabled={!selected.length}
                  onClick={() => setSelected([])}
                >
                  清空
                </Button>
              </div>
            ) : null}
          </CardHeader>
          <CardContent>
            {vms.length === 0 ? (
              <EmptyState
                reason='还没有槽位。'
                actionLabel='去虚拟机'
                to='/vm'
              />
            ) : (
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className='w-8'>
                        <Checkbox
                          aria-label='全选槽位'
                          checked={
                            selected.length === vms.length
                              ? true
                              : selected.length
                                ? 'indeterminate'
                                : false
                          }
                          onCheckedChange={(v) =>
                            setSelected(
                              v === true ? vms.map((vm) => vm.id) : []
                            )
                          }
                        />
                      </TableHead>
                      <TableHead>槽</TableHead>
                      <TableHead>OS</TableHead>
                      <TableHead>引擎</TableHead>
                      <TableHead>母本</TableHead>
                      <TableHead>上次结果</TableHead>
                      <TableHead className='text-right'>动作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {vms.map((vm) => {
                      const engine = engineOf(vm)
                      const rust = engine === 'rust'
                      const source = data?.meta?.source_vm === vm.id
                      const tone = slotSyncTone(syncById.get(vm.id))
                      return (
                        <TableRow
                          key={vm.id}
                          data-state={
                            selected.includes(vm.id) ? 'selected' : undefined
                          }
                        >
                          <TableCell>
                            <Checkbox
                              checked={selected.includes(vm.id)}
                              onCheckedChange={(v) => toggle(vm.id, v === true)}
                              aria-label={`选择 ${vm.id}`}
                            />
                          </TableCell>
                          <TableCell className='font-mono text-xs'>
                            <Link
                              to='/vm/$id'
                              params={{ id: vm.id }}
                              className='underline underline-offset-4'
                            >
                              {vm.id}
                            </Link>
                          </TableCell>
                          <TableCell className='text-muted-foreground'>
                            {osOf(vm)}
                          </TableCell>
                          <TableCell>
                            {inferenceEngineLabel(
                              normalizeInferenceEngine(engine, 'auto')
                            )}
                          </TableCell>
                          <TableCell className='text-muted-foreground'>
                            {source ? '当前来源' : rust ? '可晋升' : '只收文件'}
                          </TableCell>
                          <TableCell>
                            {tone ? (
                              <StatusMark tone={tone} />
                            ) : (
                              <span className='text-xs text-muted-foreground'>
                                —
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className='flex justify-end gap-2'>
                              <Button
                                size='sm'
                                variant='outline'
                                className='cursor-pointer'
                                disabled={!rust || promote.isPending}
                                onClick={() => setPromoteId(vm.id)}
                              >
                                晋升 wrap 文件
                              </Button>
                              <Button
                                size='sm'
                                variant='outline'
                                className='cursor-pointer'
                                disabled={!complete || repair.isPending}
                                loading={
                                  repair.isPending && repair.variables === vm.id
                                }
                                onClick={() => repair.mutate(vm.id)}
                              >
                                重装 kernel
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            {rustVms.length === 0 ? (
              <p className='mt-3 text-xs text-muted-foreground'>
                没有 rust cli-hop 槽时仍可同步文件，但不会启动 wrap kernel。
              </p>
            ) : null}
          </CardContent>
        </Card>
      </QueryGate>
      <ConfirmDialog
        open={!!promoteId}
        onOpenChange={(open) => {
          if (!open) setPromoteId(null)
        }}
        title='覆盖 wrap 母样本？'
        desc={`用 ${promoteId || ''} 槽内已验证的 .kin 覆盖 share/wrap-cli。不会复制凭证或 SOCKS。下次重装仍优先仓内最新 kernel。`}
        confirmText='晋升 wrap 文件'
        cancelBtnText='取消'
        isLoading={promote.isPending}
        handleConfirm={() => {
          if (promoteId) promote.mutate(promoteId)
        }}
      />
      <ConfirmDialog
        open={makeOpen}
        onOpenChange={setMakeOpen}
        title='重整 wrap 文件？'
        desc='用当前 share/wrap-cli 里已有的 cli-node，补 kernel wrapper / shim，并叠上仓内最新 kernel。缺 cli-node 会失败。Debian 12 可从一台 Ubuntu 槽拷 glibc 2.39 shim。'
        confirmText='重整'
        cancelBtnText='取消'
        isLoading={make.isPending}
        handleConfirm={() => make.mutate()}
      >
        <div className='space-y-1'>
          <p className='text-sm'>glibc shim 来源槽（可选）</p>
          <Select
            value={glibcVm || 'none'}
            onValueChange={(v) => setGlibcVm(v === 'none' ? '' : v)}
          >
            <SelectTrigger aria-label='glibc shim 来源槽'>
              <SelectValue placeholder='不拷 shim' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='none'>不拷 shim</SelectItem>
              {vms.map((vm) => (
                <SelectItem key={vm.id} value={vm.id}>
                  {vm.id} · {osOf(vm)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!uploadFile}
        onOpenChange={(open) => {
          if (!open) setUploadFile(null)
        }}
        title='替换 kernel 二进制？'
        desc={`将用 ${uploadFile?.name || '所选文件'}（${fmtBytes(uploadFile?.size || 0)}）覆盖仓内 bin/kin-kernel 与 share/wrap-cli/kin-kernel.bin。不会自动同步槽位；下次镜像升级会被镜像内版本覆盖。`}
        confirmText='替换'
        cancelBtnText='取消'
        isLoading={upload.isPending}
        handleConfirm={() => {
          if (uploadFile) upload.mutate(uploadFile)
        }}
      />
    </PageHeader>
  )
}
