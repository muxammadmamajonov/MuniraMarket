/**
 * Shape every dictionary must satisfy. `uz.ts` and `ru.ts` are both typed as `Dictionary`, so a
 * missing or extra key in either file is a compile-time error.
 */
export interface Dictionary {
  meta: {
    title: string;
    description: string;
  };
  dashboard: {
    title: string;
    placeholder: string;
  };
}
