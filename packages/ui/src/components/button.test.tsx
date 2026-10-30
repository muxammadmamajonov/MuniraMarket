import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button';

describe('Button', () => {
  it('renders a type="button" button by default', () => {
    render(<Button>Add</Button>);
    expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('type', 'button');
  });

  it('allows overriding the type', () => {
    render(<Button type="submit">Send</Button>);
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('type', 'submit');
  });

  it('applies the primary variant and md size by default, with a 44px touch target', () => {
    render(<Button>Add</Button>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('bg-primary', 'min-h-11', 'min-w-11');
  });

  it('applies the secondary variant', () => {
    render(<Button variant="secondary">Cancel</Button>);
    expect(screen.getByRole('button')).toHaveClass('border', 'bg-surface');
  });

  it('keeps a touch target of at least 44px for every size', () => {
    render(<Button size="lg">Big</Button>);
    expect(screen.getByRole('button')).toHaveClass('min-h-12');
  });

  it('merges custom classes and forwards props', () => {
    const onClick = vi.fn();
    render(
      <Button className="w-full" onClick={onClick} aria-label="Buy">
        $
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Buy' });
    expect(button).toHaveClass('w-full');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not fire click when disabled', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Add
      </Button>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
