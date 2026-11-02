import { ImagePlaceholder } from '@muniramarket/ui';
import { initialOf, toneFor } from '@/lib/placeholder';

export interface ProductImageProps {
  src: string | null;
  /** Localized product (or category) name: the accessible name and the monogram's letter. */
  name: string;
  /** Picks the tint: products of one category share a family. */
  toneKey: string;
  className?: string;
}

/**
 * Square product image. Without a photo (or when it fails to load) it shows a soft tinted tile
 * with the name's initial, so every card has the same size and a deliberate look, and nothing
 * shifts when images arrive. The tile is drawn here: no external assets.
 */
export function ProductImage({ src, name, toneKey, className }: ProductImageProps) {
  return (
    <ImagePlaceholder
      src={src}
      alt={name}
      {...(className === undefined ? {} : { className })}
      fallback={<Monogram letter={initialOf(name)} tone={toneFor(toneKey)} />}
    />
  );
}

export function Monogram({ letter, tone }: { letter: string; tone: number }) {
  return (
    <div
      aria-hidden="true"
      data-testid="monogram"
      data-tone={tone}
      className={`mm-tone-${String(tone)} @container relative flex h-full w-full items-center justify-center overflow-hidden bg-(--tone-bg) text-(--tone-fg)`}
    >
      <span className="absolute -right-[18%] -bottom-[18%] h-3/4 w-3/4 rounded-full bg-(--tone-fg) opacity-[0.08]" />
      <span className="relative text-[42cqw] leading-none font-semibold select-none">{letter}</span>
    </div>
  );
}
