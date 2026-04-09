export function Toolbar() {
  return (
    <div
      className="shrink-0 px-4 pb-2"
      style={
        {
          WebkitAppRegion: 'drag',
          paddingTop: '36px' // clear the macOS traffic lights
        } as React.CSSProperties
      }
    >
      <span className="text-zinc-500 text-xs font-medium tracking-widest uppercase select-none">
        Vectra
      </span>
    </div>
  )
}
