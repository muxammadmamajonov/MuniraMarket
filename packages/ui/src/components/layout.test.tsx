import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Container, Screen } from './layout';

describe('Container', () => {
  it('renders a div with width cap and gutters', () => {
    render(<Container data-testid="c">x</Container>);
    const el = screen.getByTestId('c');
    expect(el.tagName).toBe('DIV');
    expect(el).toHaveClass('mx-auto', 'max-w-3xl', 'px-4');
  });

  it('can render another element', () => {
    render(
      <Container as="section" data-testid="c">
        x
      </Container>,
    );
    expect(screen.getByTestId('c').tagName).toBe('SECTION');
  });
});

describe('Screen', () => {
  it('renders the main landmark filling the viewport', () => {
    render(<Screen>content</Screen>);
    const main = screen.getByRole('main');
    expect(main).toHaveClass('min-h-dvh');
    expect(main).toHaveTextContent('content');
  });
});
