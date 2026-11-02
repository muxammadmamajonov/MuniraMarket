/**
 * MuniraMarket wordmark: a small leaf-and-M mark drawn here plus the name set in the system font.
 * Text and SVG only, no external assets. The mark is decorative; the link around it carries the
 * name.
 */
export function Wordmark({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-[360px]:gap-2">
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 28 28"
        width="28"
        height="28"
        className="size-6 shrink-0 min-[360px]:size-7"
      >
        <rect width="28" height="28" rx="8" className="fill-primary" />
        <path
          d="M7.5 20V9.5L14 16.5l6.5-7V20"
          fill="none"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-primary-foreground"
        />
        <path
          d="M20.5 6.5c0 2.2-1.6 3.6-3.6 3.6 0-2.2 1.6-3.6 3.6-3.6z"
          className="fill-primary-foreground"
        />
      </svg>
      <span className="text-[15px] leading-none font-bold tracking-tight min-[360px]:text-[17px]">
        {name}
      </span>
    </span>
  );
}
