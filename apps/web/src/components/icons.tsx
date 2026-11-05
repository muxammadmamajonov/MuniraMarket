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

export const ChevronLeftIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m14.5 6-6 6 6 6" />
  </Icon>
);

export const HomeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 10.5 12 4l8 6.5" />
    <path d="M6 9v9.5A1.5 1.5 0 0 0 7.5 20H10v-5.5h4V20h2.5a1.5 1.5 0 0 0 1.5-1.5V9" />
  </Icon>
);

/** Catalog: four rounded tiles. */
export const GridIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.8" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8" />
  </Icon>
);

export const UserIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
  </Icon>
);

export const GlobeIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z" />
  </Icon>
);

/** Folded paper map, for "show on the map". */
export const MapIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m3.5 6.5 5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2z" />
    <path d="M9 4.5v13M15 6.5v13" />
  </Icon>
);

/** Crosshair, for "my location". */
export const LocateIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="5.5" />
    <circle cx="12" cy="12" r="1.5" />
    <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
  </Icon>
);
