import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Loading from './loading';

describe('loading skeleton', () => {
  it('mirrors the storefront: a two-column grid of card-shaped placeholders, hidden from assistive tech', () => {
    const { container } = render(<Loading />);
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    const tiles = screen.getAllByTestId('tile-skeleton');
    expect(tiles.length).toBeGreaterThanOrEqual(8);
    expect(tiles[0]?.parentElement).toHaveClass('grid-cols-2');
    // Same footprint as a real tile: a borderless square photo (the add button sits on it), then
    // the price line; no card frame around it.
    expect(tiles[0]?.querySelector('.aspect-square')).not.toBeNull();
    expect(tiles[0]?.querySelector('.h-5')).not.toBeNull();
    expect(tiles[0]).not.toHaveClass('border');
    for (const block of container.querySelectorAll('.animate-pulse')) {
      expect(block).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
