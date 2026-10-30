import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImagePlaceholder } from './image-placeholder';
import { ProductCard } from './product-card';
import { QuantityStepper } from './quantity-stepper';
import { Skeleton } from './skeleton';
import { EmptyState, ErrorState } from './states';

describe('ImagePlaceholder', () => {
  it('renders the image when a URL is given', () => {
    render(<ImagePlaceholder src="https://img.test/a.jpg" alt="Apple" />);
    expect(screen.getByRole('img', { name: 'Apple' })).toHaveAttribute(
      'src',
      'https://img.test/a.jpg',
    );
    expect(screen.queryByTestId('image-placeholder')).toBeNull();
  });

  it('renders the placeholder when the URL is null', () => {
    render(<ImagePlaceholder src={null} alt="Apple" />);
    expect(screen.getByTestId('image-placeholder')).toHaveAttribute('aria-label', 'Apple');
    expect(document.querySelector('img')).toBeNull();
  });

  it('falls back to the placeholder when the image fails to load', () => {
    render(<ImagePlaceholder src="https://img.test/broken.jpg" alt="Apple" />);
    fireEvent.error(document.querySelector('img') as HTMLImageElement);
    expect(screen.getByTestId('image-placeholder')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('is full width by default but never combines w-full with a caller-provided width', () => {
    const { container, rerender } = render(<ImagePlaceholder src={null} alt="Apple" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).toHaveClass('w-full');

    rerender(<ImagePlaceholder src={null} alt="Apple" className="w-20 shrink-0" />);
    expect(wrapper).toHaveClass('w-20');
    expect(wrapper).not.toHaveClass('w-full');
  });
});

describe('ProductCard', () => {
  const base = {
    href: '/uz/p/demo-apple',
    locale: 'uz' as const,
    name: 'Olma',
    price: 12000,
  };

  it('links to the product with name, price and unit', () => {
    render(<ProductCard {...base} imageUrl={null} unitLabel="kg" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/uz/p/demo-apple');
    expect(link).toHaveTextContent('Olma');
    expect(link.textContent).toContain('12\u00A0000\u00A0so\u2018m');
    expect(link).toHaveTextContent('/ kg');
  });

  it('shows the image placeholder when image_url is null', () => {
    render(<ProductCard {...base} imageUrl={null} />);
    expect(screen.getByTestId('image-placeholder')).toBeInTheDocument();
  });

  it('shows the old price struck through and the stock label', () => {
    const { container } = render(
      <ProductCard {...base} imageUrl={null} oldPrice={15000} stockLabel="Out of stock" />,
    );
    expect(container.querySelector('del')?.textContent).toContain('15\u00A0000');
    expect(screen.getByText('Out of stock')).toBeInTheDocument();
  });

  it('uses the supplied link component', () => {
    render(
      <ProductCard
        {...base}
        imageUrl={null}
        linkComponent={({ href, children }) => (
          <a data-custom href={href}>
            {children}
          </a>
        )}
      />,
    );
    expect(screen.getByRole('link')).toHaveAttribute('data-custom');
  });
});

describe('QuantityStepper', () => {
  const labels = { label: 'Quantity', decreaseLabel: 'Less', increaseLabel: 'More' };

  it('increments and decrements within bounds', () => {
    const onChange = vi.fn();
    render(<QuantityStepper value={2} onChange={onChange} {...labels} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(onChange).toHaveBeenLastCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: 'Less' }));
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('disables the buttons at min and max', () => {
    const { rerender } = render(<QuantityStepper value={1} onChange={vi.fn()} {...labels} />);
    expect(screen.getByRole('button', { name: 'Less' })).toBeDisabled();
    rerender(<QuantityStepper value={5} max={5} onChange={vi.fn()} {...labels} />);
    expect(screen.getByRole('button', { name: 'More' })).toBeDisabled();
  });

  it('disables everything when disabled', () => {
    render(<QuantityStepper value={3} disabled onChange={vi.fn()} {...labels} />);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });
});

describe('Skeleton / EmptyState / ErrorState', () => {
  it('skeleton is hidden from assistive tech', () => {
    render(<Skeleton data-testid="s" className="h-4" />);
    expect(screen.getByTestId('s')).toHaveAttribute('aria-hidden', 'true');
  });

  it('empty state shows title, description and action', () => {
    render(<EmptyState title="Empty" description="Nothing here" action={<a href="/">Home</a>} />);
    expect(screen.getByRole('heading', { name: 'Empty' })).toBeInTheDocument();
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('error state is an alert with a working retry button', () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Oops" retryLabel="Retry" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Oops');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('error state without a retry handler has no button', () => {
    render(<ErrorState title="Oops" retryLabel="Retry" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
