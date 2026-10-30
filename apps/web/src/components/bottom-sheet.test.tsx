import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet } from './bottom-sheet';

function Harness({ dismissible = true }: { dismissible?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>trigger</button>
      <button>outside</button>
      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Sheet title"
        description="Sheet description"
        closeLabel="Close"
        dismissible={dismissible}
      >
        <textarea data-autofocus="" aria-label="reason" />
        <button>inner</button>
      </BottomSheet>
    </>
  );
}

afterEach(() => {
  vi.useRealTimers();
  document.body.style.overflow = '';
});

describe('BottomSheet', () => {
  it('renders nothing while closed and a labelled modal dialog while open', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('trigger'));
    const dialog = screen.getByRole('dialog', { name: 'Sheet title' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Sheet description');
  });

  it('slides from the bottom with transform/opacity transitions of 200ms and a custom curve', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('trigger'));
    const dialog = screen.getByRole('dialog');
    const classes = dialog.className;
    expect(classes).toContain('transition-[transform,opacity]');
    expect(classes).toContain('duration-200');
    expect(classes).toContain('ease-drawer');
    expect(classes).toContain('starting:transform-[translateY(100%)]');
    expect(classes).toContain('data-[closing=true]:transform-[translateY(100%)]');
    // Reduced motion: no movement.
    expect(classes).toContain('motion-reduce:transform-none');
    // Only compositor properties are transitioned: never `all`, never layout properties.
    expect(classes).not.toMatch(/transition-all|transition-\[(height|width|margin|padding)/);
    expect(classes).not.toContain('ease-in ');
  });

  it('pads the content by the safe-area inset and keeps scroll inside the sheet', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('trigger'));
    const content = screen.getByLabelText('reason').closest('div.overflow-y-auto');
    expect(content?.className).toContain('safe-area-inset-bottom');
    expect(content?.className).toContain('overscroll-contain');
    expect(screen.getByRole('dialog').className).toContain('max-h-[90dvh]');
  });

  it('moves focus in, locks page scroll, and restores both on close', () => {
    vi.useFakeTimers();
    render(<Harness />);
    const trigger = screen.getByText('trigger');
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByLabelText('reason')).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-closing', 'true');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(trigger).toHaveFocus();
  });

  it('closes with Escape and with a tap on the backdrop', () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.click(screen.getByText('trigger'));
    fireEvent.keyDown(screen.getByLabelText('reason'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toHaveAttribute('data-closing', 'true');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByText('trigger'));
    fireEvent.click(screen.getByTestId('sheet-backdrop'));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-closing', 'true');
  });

  it('keeps Tab inside the sheet', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('trigger'));
    const inner = screen.getByText('inner');
    inner.focus();
    fireEvent.keyDown(inner, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), {
      key: 'Tab',
      shiftKey: true,
    });
    expect(inner).toHaveFocus();
  });

  it('cannot be dismissed while an action is in flight', () => {
    render(<Harness dismissible={false} />);
    fireEvent.click(screen.getByText('trigger'));
    fireEvent.keyDown(screen.getByLabelText('reason'), { key: 'Escape' });
    fireEvent.click(screen.getByTestId('sheet-backdrop'));
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getByRole('dialog')).toHaveAttribute('data-closing', 'false');
  });
});
