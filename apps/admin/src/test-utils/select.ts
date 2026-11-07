import { fireEvent, screen } from '@testing-library/react';

/**
 * Helpers for the custom `Select` (`components/ui/select.tsx`), which is a button + listbox, not a
 * native `<select>`: `fireEvent.change` does nothing on it.
 */

/** The open listbox of the select whose trigger has `testId` (opens it first if needed). */
export function openOptions(testIdOrTrigger: string | HTMLElement): HTMLElement[] {
  const trigger =
    typeof testIdOrTrigger === 'string' ? screen.getByTestId(testIdOrTrigger) : testIdOrTrigger;
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const list = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
  if (list === null) throw new Error('select list did not open');
  return Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
}

/** Chooses the option with `value` in the select whose trigger has `testId`. */
export function chooseOption(testIdOrTrigger: string | HTMLElement, value: string): void {
  const option = openOptions(testIdOrTrigger).find((item) => item.dataset['value'] === value);
  if (option === undefined) throw new Error(`no option with value ${value}`);
  fireEvent.click(option);
}
