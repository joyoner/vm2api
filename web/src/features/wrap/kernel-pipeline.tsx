import type { ReactNode } from 'react'
import type { StatusTone } from '@/types/status'
import { Box, Container, HardDrive, Package } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StatusMark } from '@/components/status-mark'

export type StationId = 'image' | 'repo' | 'sample' | 'slots'

export type Station = {
  id: StationId
  label: string
  caption: string
  tone: StatusTone
}

const ICON: Record<StationId, typeof Box> = {
  image: Container,
  repo: HardDrive,
  sample: Package,
  slots: Box,
}

/**
 * kernel 分发链路：镜像 → 仓内二进制 → 母样本 → 槽内。
 * 每一站既是状态展示也是导航：选中后下方渲染该站的详情与动作。
 */
export function KernelPipeline({
  stations,
  active,
  onSelect,
  busy,
  trailing,
}: {
  stations: Station[]
  active: StationId
  onSelect: (id: StationId) => void
  busy?: boolean
  trailing?: ReactNode
}) {
  return (
    <div className='rounded-lg border bg-card p-3 sm:p-4'>
      <div className='flex flex-col gap-3 lg:flex-row lg:items-stretch'>
        <ol className='grid flex-1 grid-cols-2 gap-2 sm:grid-cols-4'>
          {stations.map((station, i) => {
            const Icon = ICON[station.id]
            const on = active === station.id
            return (
              <li key={station.id} className='relative min-w-0'>
                {i > 0 ? (
                  <span
                    aria-hidden
                    className={cn(
                      'absolute top-1/2 -left-1 hidden h-px w-2 -translate-y-1/2 sm:block',
                      busy
                        ? 'bg-primary motion-safe:animate-pulse'
                        : 'bg-border'
                    )}
                  />
                ) : null}
                <button
                  type='button'
                  aria-pressed={on}
                  onClick={() => onSelect(station.id)}
                  className={cn(
                    'flex w-full cursor-pointer flex-col gap-1.5 rounded-md border p-3 text-left transition-colors duration-200',
                    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-none',
                    on
                      ? 'border-primary/60 bg-primary/5'
                      : 'border-transparent bg-transparent hover:bg-accent/40'
                  )}
                >
                  <span className='flex items-center gap-2'>
                    <Icon
                      className='size-4 shrink-0 text-muted-foreground'
                      aria-hidden
                    />
                    <span className='truncate text-sm font-medium'>
                      {station.label}
                    </span>
                    <span className='ml-auto text-[10px] text-muted-foreground tabular-nums'>
                      {i + 1}/{stations.length}
                    </span>
                  </span>
                  <StatusMark tone={station.tone} />
                  <span
                    className='truncate font-mono text-[11px] text-muted-foreground'
                    title={station.caption}
                  >
                    {station.caption}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
        {trailing ? (
          <div className='flex items-center justify-between gap-4 border-t pt-3 lg:justify-start lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4'>
            {trailing}
          </div>
        ) : null}
      </div>
    </div>
  )
}
