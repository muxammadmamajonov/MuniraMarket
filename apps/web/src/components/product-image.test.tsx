import { fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { toneFor } from '@/lib/placeholder';
import { ProductImage } from './product-image';

describe('ProductImage', () => {
  it('shows the tinted monogram of the name when there is no image', () => {
    render(<ProductImage src={null} name="Pomidor" toneKey="cat-1" />);
    const monogram = screen.getByTestId('monogram');
    expect(monogram).toHaveTextContent('P');
    expect(monogram).toHaveClass(`mm-tone-${String(toneFor('cat-1'))}`);
    expect(screen.getByRole('img', { name: 'Pomidor' })).toBeInTheDocument();
  });

  it('gives products of one category the same tint, whatever their names', () => {
    render(
      <>
        <ProductImage src={null} name="Olma" toneKey="cat-7" />
        <ProductImage src={null} name="Banan" toneKey="cat-7" />
      </>,
    );
    const [first, second] = screen.getAllByTestId('monogram');
    expect(first?.dataset['tone']).toBe(second?.dataset['tone']);
  });

  it('shows the photo when there is one', () => {
    render(<ProductImage src="https://cdn.example/olma.jpg" name="Olma" toneKey="c" />);
    expect(screen.getByRole('img', { name: 'Olma' })).toHaveAttribute(
      'src',
      'https://cdn.example/olma.jpg',
    );
    expect(screen.queryByTestId('monogram')).not.toBeInTheDocument();
  });

  it('fades the photo in once it has loaded, then keeps it', () => {
    render(<ProductImage src="https://cdn.example/olma.jpg" name="Olma" toneKey="c" />);
    const img = screen.getByRole('img', { name: 'Olma' });
    expect(img).toHaveAttribute('data-loaded', 'false');
    expect(img).toHaveClass('opacity-0');
    fireEvent.load(img);
    expect(img).toHaveAttribute('data-loaded', 'true');
    expect(img).toHaveClass('opacity-100', 'transition-opacity');
  });

  it('lazy-loads into a fixed box so nothing shifts', () => {
    render(<ProductImage src="/products/olma.webp" name="Olma" toneKey="c" />);
    const img = screen.getByRole('img', { name: 'Olma' });
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('width', '800');
    expect(img).toHaveAttribute('height', '800');
    expect(img.parentElement).toHaveClass('mm-photo', 'aspect-square');
  });

  it('offers the 400px file of its own photos with the given sizes', () => {
    render(
      <ProductImage
        src="/products/olma.webp"
        name="Olma"
        toneKey="c"
        sizes="(min-width: 768px) 25vw, 50vw"
      />,
    );
    const img = screen.getByRole('img', { name: 'Olma' });
    expect(img).toHaveAttribute('srcset', '/products/olma-400.webp 400w, /products/olma.webp 800w');
    expect(img).toHaveAttribute('sizes', '(min-width: 768px) 25vw, 50vw');
  });

  it('falls back to the monogram when the photo fails to load', () => {
    render(<ProductImage src="https://cdn.example/broken.jpg" name="Olma" toneKey="c" />);
    fireEvent.error(screen.getByRole('img', { name: 'Olma' }));
    expect(screen.getByTestId('monogram')).toHaveTextContent('O');
    expect(screen.getByRole('img', { name: 'Olma' })).toHaveAttribute(
      'data-testid',
      'image-placeholder',
    );
  });

  it('loads the product page photo eagerly', () => {
    render(<ProductImage src="/products/olma.webp" name="Olma" toneKey="c" priority />);
    expect(screen.getByRole('img', { name: 'Olma' })).toHaveAttribute('loading', 'eager');
  });

  it('is visible in the server markup, so a photo never waits for JavaScript', () => {
    const html = renderToString(<ProductImage src="/products/olma.webp" name="Olma" toneKey="c" />);
    expect(html).toContain('data-loaded="true"');
    expect(html).toContain('opacity-100');
    expect(html).not.toContain('opacity-0');
  });
});
