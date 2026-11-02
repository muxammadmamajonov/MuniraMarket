import { render, screen } from '@testing-library/react';
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
});
