import type { SVGProps } from 'react';

/**
 * Small inline icons drawn for this app (24x24 grid, 2px round strokes, `currentColor`). They are
 * decorative: the control that holds them carries the accessible name.
 */
function Icon({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export type IconProps = SVGProps<SVGSVGElement>;

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const MinusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14" />
  </Icon>
);

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Icon>
);

export const BagIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5.5 8.5h13l-1 10.2a1.5 1.5 0 0 1-1.5 1.3H8a1.5 1.5 0 0 1-1.5-1.3z" />
    <path d="M9 8.5V7a3 3 0 0 1 6 0v1.5" />
  </Icon>
);

export const ReceiptIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 3.5h12v17l-3-1.8-3 1.8-3-1.8-3 1.8z" />
    <path d="M9.5 8.5h5M9.5 12h5" />
  </Icon>
);

export const PinIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15.4 12 21 12 21z" />
    <circle cx="12" cy="10" r="2.3" />
  </Icon>
);

export const WalletIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="6" width="17" height="13" rx="2.5" />
    <path d="M3.5 10h17M15.5 14.5h1.5" />
  </Icon>
);

export const BasketIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 9.5h17l-1.6 8.2a2 2 0 0 1-2 1.8H7.1a2 2 0 0 1-2-1.8z" />
    <path d="m8 9.5 3-5M16 9.5l-3-5" />
  </Icon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m9.5 6 6 6-6 6" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);
