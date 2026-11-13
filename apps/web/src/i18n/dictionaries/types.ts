import type {
  OrderStatus,
  PaymentMethod,
  ProductSort,
  ProductUnit,
  TelegramOidcFailureStatus,
} from '@muniramarket/contracts';

/**
 * Noun forms by CLDR plural category. Russian needs `one` / `few` / `many`; Uzbek uses the same
 * text for every category. `{count}` is filled by `formatPlural`.
 */
export interface PluralForms {
  one: string;
  few: string;
  many: string;
  other: string;
}

/**
 * Shape every dictionary must satisfy. `uz.ts` and `ru.ts` are both typed as `Dictionary`, so a
 * missing or extra key in either file is a compile-time error.
 *
 * Strings may contain `{name}` placeholders, filled with `formatMessage`. Both languages must use
 * the same placeholders (checked in `index.test.ts`).
 */
export interface Dictionary {
  meta: {
    title: string;
    description: string;
  };
  nav: {
    home: string;
    cart: string;
    /** "My orders". */
    orders: string;
    search: string;
    mainNavigation: string;
    catalog: string;
    profile: string;
    /** Accessible name of the mobile bottom navigation. */
    tabBar: string;
    /** Cart tab name with the unit count, for screen readers. `{count}` */
    cartWithCount: string;
  };
  home: {
    title: string;
    tagline: string;
    categoriesHeading: string;
    /** Link from a home section heading to the full list (the catalog). */
    seeAll: string;
    newestHeading: string;
    /** Shown instead of the sections when the catalog has no categories and no products. */
    emptyTitle: string;
    emptyHint: string;
    /** How ordering works; only what the app really does. */
    info: {
      paymentTitle: string;
      paymentText: string;
      /** Who brings the order and who is paid for delivery. */
      courierTitle: string;
      courierText: string;
    };
  };
  /** The delivery address card at the top of the storefront (opens the map picker). */
  address: {
    /** Small label above a chosen address. */
    heading: string;
    /** Before a choice: the one line on the card, which is itself the button. */
    choosePrompt: string;
    change: string;
    /** Screen-reader announcement after saving. */
    saved: string;
    /** Parts of the one-line address. `{value}` */
    apartmentShort: string;
    entranceShort: string;
    floorShort: string;
  };
  /**
   * The address picker (Yandex Maps + address form): the customer moves the map under a centre
   * pin, the point is reverse-geocoded into street and house, and "Deliver here" saves the address.
   */
  map: {
    title: string;
    close: string;
    /** Accessible name of the map canvas, including how to pan it by keyboard. */
    canvasLabel: string;
    loading: string;
    /** No Maps key configured: a point cannot be chosen. */
    unavailableTitle: string;
    unavailableText: string;
    errorTitle: string;
    offlineTitle: string;
    errorText: string;
    retry: string;
    /** Above the form: how the centre pin works. */
    hint: string;
    myLocation: string;
    locating: string;
    locationDenied: string;
    locationUnavailable: string;
    /** Accessible description of the centre pin. */
    pinLabel: string;
    /** While the pin's street and house are being looked up. */
    geocoding: string;
    /** The lookup found no street/house: the customer types them. */
    geocodeFailed: string;
    street: string;
    house: string;
    apartment: string;
    entrance: string;
    floor: string;
    landmark: string;
    landmarkPlaceholder: string;
    optional: string;
    /** "Deliver here" before the pin was ever placed (moved or located). */
    placePin: string;
    /** Saves the address and closes the picker. */
    deliverHere: string;
  };
  search: {
    label: string;
    /** Accessible name of the button that empties the search field. */
    clear: string;
    placeholder: string;
    submit: string;
    heading: string;
    /** `{query}` */
    resultsFor: string;
    /** `{min}` */
    tooShort: string;
    noResults: string;
    noResultsHint: string;
  };
  catalog: {
    categoryLabel: string;
    subcategories: string;
    sortLabel: string;
    sort: Record<ProductSort, string>;
    /** `{count}` */
    productsCount: string;
    emptyCategory: string;
    filterLabel: string;
    /** Toggle: only products that can be added to the cart now. */
    inStockOnly: string;
    /** Empty listing while the in-stock filter is on. */
    noneInStock: string;
    clearFilter: string;
    pagination: {
      label: string;
      previous: string;
      next: string;
      /** `{page}`, `{total}` */
      position: string;
    };
  };
  product: {
    sku: string;
    brand: string;
    description: string;
    /** Heading of the product's details block (description, SKU, brand). */
    about: string;
    /** `{count}`: how much of this product the cart already holds (units of its own measure). */
    inCart: string;
    category: string;
    inStock: string;
    outOfStock: string;
    /** `{count}` */
    lowStock: string;
    priceCurrentLabel: string;
    priceOldLabel: string;
    quantity: string;
    decrease: string;
    increase: string;
    addToCart: string;
    /** Short label of the add button on a product card. */
    addShort: string;
    adding: string;
    added: string;
    viewCart: string;
    /** `{count}` */
    maxPerOrder: string;
    errors: {
      productInactive: string;
      /** `{available}` */
      insufficientStock: string;
      cartLimit: string;
      /** The API asked us to wait; the add button stays disabled for as long as it said. */
      rateLimited: string;
      generic: string;
    };
  };
  cart: {
    title: string;
    loading: string;
    empty: string;
    emptyHint: string;
    continueShopping: string;
    /** Under the cart total: delivery is paid to the courier, not to the store. */
    deliveryNote: string;
    /** `{count}` */
    itemCount: string;
    subtotal: string;
    total: string;
    remove: string;
    issueInactive: string;
    /** `{available}` */
    issueInsufficientStock: string;
    issuesNote: string;
    /** Checkout button; the Telegram MainButton appends the total. */
    checkout: string;
    loadFailed: string;
    updateFailed: string;
    /** `{available}` */
    updateInsufficientStock: string;
    /** The API asked us to wait; the controls are disabled for as long as it said. */
    updateRateLimited: string;
    retry: string;
  };
  checkout: {
    title: string;
    loading: string;
    loadFailed: string;
    retry: string;
    emptyTitle: string;
    emptyHint: string;
    toCatalog: string;
    /**
     * Shown instead of the empty cart when an attempt that did not get its answer (a timeout, then
     * a reload) turns out to have placed the order.
     */
    recovered: {
      title: string;
      /** `{number}` */
      hint: string;
      action: string;
    };
    optional: string;
    sections: {
      delivery: string;
      recipient: string;
      payment: string;
      comment: string;
      summary: string;
    };
    labels: {
      recipientName: string;
      recipientPhone: string;
      comment: string;
    };
    paymentHint: string;
    /** One plain line: who brings the order and who is paid for delivery. */
    courierNote: string;
    /** Step 1 before an address is chosen: opens the map picker. */
    chooseAddress: string;
    changeAddress: string;
    commentPlaceholder: string;
    /** `{count}`, `{max}` */
    charCounter: string;
    summary: {
      items: PluralForms;
      total: string;
      calculating: string;
      cartIssues: string;
      quoteFailed: string;
      /** `{hint}` shown when the submit button is disabled because of the form. */
      fixFields: string;
    };
    submit: string;
    placing: string;
    confirmNewTotal: string;
    errors: {
      required: string;
      /** `{min}` */
      tooShort: string;
      /** `{max}` */
      tooLong: string;
      phone: string;
      singleLine: string;
      invalid: string;
      /** Summary shown above the form after a failed submit. */
      formInvalid: string;
    };
    failures: {
      priceChangedTitle: string;
      /** `{from}`, `{to}` */
      priceChanged: string;
      priceWas: string;
      priceNow: string;
      /** `{available}` */
      insufficientStock: string;
      insufficientStockUnknown: string;
      productInactive: string;
      cartEmpty: string;
      /** `{seconds}` */
      rateLimited: string;
      session: string;
      blocked: string;
      network: string;
      server: string;
      keyConflict: string;
      tooManyOpenOrders: string;
      goToOrders: string;
      unmapped: string;
      retry: string;
      /** Shown, visually only, beside `retry` while a rate-limit wait runs. `{seconds}` */
      retryCountdown: string;
      goToCart: string;
    };
  };
  orders: {
    title: string;
    loading: string;
    loadFailed: string;
    retry: string;
    emptyTitle: string;
    emptyHint: string;
    toCatalog: string;
    /** `{page}` */
    pageEmpty: string;
    firstPage: string;
    /** `{number}` */
    orderNumber: string;
    items: PluralForms;
    status: Record<OrderStatus, string>;
    payment: Record<PaymentMethod, string>;
    detail: {
      /** `{number}` */
      loadingLabel: string;
      placedTitle: string;
      placedHint: string;
      /** `?placed=found`: the retry was answered with the order an earlier attempt created. */
      foundTitle: string;
      foundHint: string;
      notFoundTitle: string;
      notFoundMessage: string;
      timeline: string;
      /** Marks the latest entry of the timeline. */
      current: string;
      itemsHeading: string;
      /** `{quantity}`, `{price}`, `{unit}` */
      lineBreakdown: string;
      total: string;
      deliveryHeading: string;
      /** Who brings the order and who is paid for delivery. */
      courierNote: string;
      street: string;
      house: string;
      apartment: string;
      entrance: string;
      floor: string;
      landmark: string;
      recipientHeading: string;
      name: string;
      phone: string;
      paymentHeading: string;
      commentHeading: string;
      cancelReasonHeading: string;
      cancelledNotice: string;
      productRemoved: string;
    };
    cancel: {
      button: string;
      title: string;
      description: string;
      reasonLabel: string;
      quickLabel: string;
      quickReasons: {
        changedMind: string;
        wrongOrder: string;
        wrongAddress: string;
        foundElsewhere: string;
      };
      /** `{count}`, `{max}` */
      counter: string;
      confirm: string;
      cancelling: string;
      keep: string;
      close: string;
      /** `{min}` */
      tooShort: string;
      notCancellable: string;
      /** `{status}` */
      notCancellableNow: string;
      network: string;
      generic: string;
      done: string;
    };
  };
  auth: {
    checking: string;
    /** Browser without Telegram login: how to use the cart. */
    openInTelegram: string;
    /** Mini App, session could not be established. */
    miniAppFailed: string;
    retry: string;
    loginHeading: string;
    loginHint: string;
    /** The "Sign in with Telegram" button. */
    loginButton: string;
    /** Button label while the sign-in is starting (before the browser leaves for Telegram). */
    loginStarting: string;
    /** Inline error: the sign-in could not be started (generic). */
    loginStartFailed: string;
    /** Inline error: Telegram sign-in is turned off for this site. */
    loginDisabled: string;
    accountBlocked: string;
    rateLimited: string;
    serviceUnavailable: string;
    /** Branded sign-in screen (cart, orders, profile, checkout). */
    screenTitle: string;
    screenSubtitle: string;
    benefits: readonly string[];
    /** Under the button: what signing in with Telegram does and does not do. */
    trust: string;
    /** The sign-in options could not be loaded. */
    configFailed: string;
    logout: string;
    /** `{name}` */
    signedInAs: string;
    /** `/<locale>/auth/telegram`: heading when Telegram sign-in did not complete. */
    callbackTitle: string;
    /** Message per `?status=` of the sign-in failure page (unknown values use `failed`). */
    callbackStatus: Record<TelegramOidcFailureStatus, string>;
    callbackBack: string;
  };
  units: Record<ProductUnit, string>;
  errors: {
    title: string;
    message: string;
    retry: string;
    notFoundTitle: string;
    notFoundMessage: string;
    backHome: string;
  };
  offline: {
    banner: string;
  };
  status: {
    label: string;
    telegram: string;
    browser: string;
  };
  profile: {
    title: string;
    /** Shown while the session is still being checked. */
    checking: string;
    anonymousTitle: string;
    /** Why to sign in; the sign-in control itself is the shared `SignInPrompt`. */
    anonymousText: string;
    /** Under the language choice: it is one setting shared with the bot. */
    languageHint: string;
    /** Inline error when the language could not be saved. */
    languageFailed: string;
    /** Footer line in the Mini App: no sign-out, the Telegram account is the session. */
    miniAppSession: string;
  };
  /** Account phone: shared from Telegram (Mini App) or via the bot (browser). Never typed. */
  phone: {
    heading: string;
    verified: string;
    notVerified: string;
    /** Why the number is needed; only what it is really used for. */
    why: string;
    share: string;
    update: string;
    updateHint: string;
    waiting: string;
    success: string;
    cancelled: string;
    timeout: string;
    checkAgain: string;
    /** Browser: open the bot, which asks for the number. */
    openBot: string;
    browserHint: string;
    /** Browser without a configured bot link. */
    openInTelegram: string;
    /** Telegram app too old for `requestContact`. */
    unsupported: string;
    checkoutTitle: string;
    checkoutText: string;
  };
  /** `/<locale>/help`: how the shop works; only what the app really does. */
  help: {
    title: string;
    intro: string;
    orderingTitle: string;
    orderingSteps: readonly string[];
    paymentTitle: string;
    paymentText: string;
    deliveryTitle: string;
    deliveryText: string;
    deliveryLink: string;
    statusTitle: string;
    statusText: string;
    phoneTitle: string;
    phoneText: string;
    languageTitle: string;
    languageText: string;
  };
  catalogPage: {
    title: string;
    emptyTitle: string;
    emptyHint: string;
  };
  /** The profile hub: grouped rows that open each settings page. */
  account: {
    accountSection: string;
    settingsSection: string;
    supportSection: string;
    personalLink: string;
    ordersLink: string;
    addressesLink: string;
    languageLink: string;
    helpLink: string;
    /** Under the name when the account has no phone yet. */
    phoneMissing: string;
    logout: string;
  };
  /** `/<locale>/profile/personal`: name, birthday and phone. */
  personal: {
    nameSection: string;
    firstName: string;
    lastName: string;
    optional: string;
    firstNameRequired: string;
    /** `{max}` characters. */
    tooLong: string;
    singleLine: string;
    birthDate: string;
    birthPlaceholder: string;
    openCalendar: string;
    pickerDone: string;
    pickerDay: string;
    pickerMonth: string;
    pickerYear: string;
    /** January..December, as shown in the date wheel. */
    months: readonly string[];
    birthIncomplete: string;
    birthInvalid: string;
    birthFuture: string;
    birthTooOld: string;
    save: string;
    saving: string;
    saved: string;
    saveFailed: string;
    phoneSection: string;
    phoneNone: string;
    verifiedBadge: string;
    unverifiedBadge: string;
    /** A typed number is not verified; ordering needs the Telegram contact. */
    unverifiedHint: string;
    changePhone: string;
    addPhone: string;
    phoneSheetTitle: string;
    phoneSheetText: string;
    shareContact: string;
    shareHint: string;
    orDivider: string;
    manualLabel: string;
    manualHint: string;
    phoneIncomplete: string;
    phoneInvalid: string;
    savePhone: string;
    phoneSaved: string;
    close: string;
  };
  /** `/<locale>/profile/addresses` and the saved-address chooser. */
  addresses: {
    loading: string;
    loadFailed: string;
    retry: string;
    emptyTitle: string;
    emptyHint: string;
    add: string;
    delete: string;
    /** Accessible name of a row's delete action; `{label}` is the address name or line. */
    deleteNamed: string;
    deleted: string;
    deleteFailed: string;
    isDefault: string;
    makeDefault: string;
    labelSection: string;
    labelHome: string;
    labelWork: string;
    labelOther: string;
    labelPlaceholder: string;
    untitled: string;
    /** `{max}` addresses. */
    limitReached: string;
    pointSection: string;
    chooseOnMap: string;
    changeOnMap: string;
    needPoint: string;
    save: string;
    saving: string;
    saved: string;
    saveFailed: string;
    notFound: string;
    deleteTitle: string;
    deleteText: string;
    keep: string;
    close: string;
    chooserTitle: string;
    newAddress: string;
    saveForLater: string;
    savedToList: string;
    /** Swipe hint for screen readers / keyboard: the delete button follows each row. */
    rowActionsHint: string;
  };
  /** Status filter on the orders page. */
  orderTabs: {
    label: string;
    all: string;
    active: string;
    delivering: string;
    done: string;
    cancelled: string;
    emptyAll: string;
    emptyAllHint: string;
    emptyActive: string;
    emptyActiveHint: string;
    emptyDelivering: string;
    emptyDeliveringHint: string;
    emptyDone: string;
    emptyDoneHint: string;
    emptyCancelled: string;
    emptyCancelledHint: string;
    /** Extra items beyond the thumbnails, e.g. `+3`. */
    moreItems: string;
  };
  /**
   * Page titles shown in the header slot (Telegram's own top row in fullscreen), so they must be
   * short: the slot is about 120px wide on a 320px phone and longer text is cut with an ellipsis.
   * Category and product pages use their own names instead.
   */
  pageTitles: {
    catalog: string;
    search: string;
    cart: string;
    checkout: string;
    orders: string;
    order: string;
    profile: string;
    help: string;
    personal: string;
    addresses: string;
    address: string;
    newAddress: string;
    language: string;
    signIn: string;
    notFound: string;
    error: string;
  };
  language: {
    label: string;
    uz: string;
    ru: string;
    /** Short labels of the compact header switch. */
    uzShort: string;
    ruShort: string;
  };
}
