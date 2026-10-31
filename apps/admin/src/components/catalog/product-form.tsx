'use client';

import type { AdminCategoryList, AdminProduct, ProductUnit } from '@muniramarket/contracts';
import { PRODUCT_UNITS } from '@muniramarket/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  ImagePlaceholder,
  Skeleton,
  formatUZS,
} from '@muniramarket/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useI18n } from '@/i18n/context';
import type { FieldKey } from '@/i18n/dictionaries/sections/shared';
import { readErrorMessage, writeErrorMessage } from '@/lib/api/error-messages';
import { FORM_LEVEL, fieldErrorsFrom } from '@/lib/api/field-errors';
import { jsonInit, request } from '@/lib/api/request';
import { isImagePreviewEnabled } from '@/lib/config';
import {
  buildCreateRequest,
  buildUpdateRequest,
  categoryTree,
  emptyProductForm,
  indentedLabel,
  isValidImageUrl,
  localName,
  productToForm,
  validateProductForm,
  type ProductFormValues,
} from '@/lib/catalog';
import { parseIntegerField } from '@/lib/numbers';
import { slugFromSku } from '@/lib/slug';
import { useSession } from '@/lib/session';
import { useApiResource } from '@/lib/use-api-resource';
import { useSingleFlight } from '@/lib/use-single-flight';
import { Alert } from '../ui/alert';
import { CARD, TEXT_LINK } from '../ui/classes';
import { ConfirmDialog } from '../ui/confirm-dialog';
import {
  CheckboxField,
  SelectField,
  TextAreaField,
  TextField,
  integerInputAttrs,
  textInputAttrs,
} from '../ui/fields';
import { PageHeader } from '../ui/page-header';
import { PermissionDenied } from '../ui/resource-view';
import { ProductStatusBadge, productState } from './product-status';

const productHref = (locale: string, id: string) =>
  `/${locale}/catalog/products/${encodeURIComponent(id)}`;

type ServerErrors = Partial<Record<FieldKey, string>>;

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-10 w-1/2" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

interface FormProps {
  categories: AdminCategoryList['items'];
  product: AdminProduct | null;
  /** Loads the product again (after archive/restore or a conflict). */
  onReload: () => void;
  created: boolean;
}

function ProductForm({ categories, product: initial, onReload, created }: FormProps) {
  const { dict, locale } = useI18n();
  const copy = dict.products.form;
  const { apiFetch } = useSession();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const { pending, run } = useSingleFlight();

  const [product, setProduct] = useState<AdminProduct | null>(initial);
  const [values, setValues] = useState<ProductFormValues>(
    initial === null ? emptyProductForm() : productToForm(initial),
  );
  const [slugTouched, setSlugTouched] = useState(initial !== null);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<ServerErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(created ? copy.created : null);
  const [dialog, setDialog] = useState<{ opener: HTMLElement | null } | null>(null);

  const archived = product !== null && product.archived_at !== null;
  const problems = submitted ? validateProductForm(values) : {};

  const set = <K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setNotice(null);
  };

  const errorFor = (key: FieldKey): string | null => {
    const problem = problems[key];
    if (problem === 'required' && key !== 'category_id' && key !== 'unit') {
      return dict.validation.required;
    }
    if (problem !== undefined) return dict.validation.fields[key];
    return serverErrors[key] ?? null;
  };
  const clearServer = (...keys: FieldKey[]) =>
    setServerErrors((previous) => {
      const next = { ...previous };
      for (const key of keys) delete next[key];
      return next;
    });

  const tree = useMemo(() => categoryTree(categories, locale), [categories, locale]);
  const categoryOptions = tree.map(({ category, depth }) => ({
    value: category.id,
    label:
      indentedLabel(localName(category, locale), depth) +
      (category.is_active ? '' : ` (${dict.common.inactive.toLowerCase()})`),
  }));
  const unitOptions = PRODUCT_UNITS.map((unit) => ({ value: unit, label: dict.units[unit] }));

  const price = parseIntegerField(values.price, { min: 0, max: 1e12 });
  const imageUrl = values.image_url.trim();
  // The admin CSP forbids external images, so the URL is never handed to the preview until image
  // storage is enabled (`isImagePreviewEnabled`).
  const previewEnabled = isImagePreviewEnabled();
  const previewSrc =
    previewEnabled && imageUrl !== '' && isValidImageUrl(imageUrl) ? imageUrl : null;

  const handleFailure = (error: Parameters<typeof writeErrorMessage>[2]) => {
    if (error.code === 'validation_error') {
      const fields = fieldErrorsFrom(error);
      const next: ServerErrors = {};
      for (const name of Object.keys(fields)) {
        if (name !== FORM_LEVEL && name in dict.validation.fields) {
          next[name as FieldKey] = dict.validation.fields[name as FieldKey];
        }
      }
      setServerErrors(next);
      setFormError(dict.validation.summary);
      return;
    }
    if (error.code === 'sku_taken') {
      setServerErrors({ sku: dict.apiErrors.codes.sku_taken });
      setFormError(null);
      return;
    }
    if (error.code === 'slug_taken') {
      setServerErrors({ slug: dict.apiErrors.codes.slug_taken });
      setFormError(null);
      return;
    }
    setFormError(writeErrorMessage(dict, locale, error));
    if (error.code === 'product_archived') onReload();
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setFormError(null);
    setNotice(null);
    if (Object.keys(validateProductForm(values)).length > 0) {
      // Move to the first problem so a screen reader and a keyboard user land on it.
      queueMicrotask(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }

    void run(async () => {
      if (product === null) {
        const result = await request<AdminProduct>(
          apiFetch,
          '/admin/products',
          jsonInit('POST', buildCreateRequest(values)),
        );
        if (!result.ok) return handleFailure(result.error);
        router.push(`${productHref(locale, result.data.id)}?created=1`);
        return;
      }
      const changes = buildUpdateRequest(values, product);
      if (Object.keys(changes).length === 0) {
        setNotice(copy.noChanges);
        return;
      }
      const result = await request<AdminProduct>(
        apiFetch,
        `/admin/products/${encodeURIComponent(product.id)}`,
        jsonInit('PATCH', changes),
      );
      if (!result.ok) return handleFailure(result.error);
      setProduct(result.data);
      setValues(productToForm(result.data));
      setServerErrors({});
      setNotice(copy.saved);
    });
  };

  const archive = async (): Promise<string | null> => {
    if (product === null) return null;
    const result = await request<AdminProduct>(
      apiFetch,
      `/admin/products/${encodeURIComponent(product.id)}`,
      jsonInit('DELETE'),
    );
    if (!result.ok) return writeErrorMessage(dict, locale, result.error);
    setProduct(result.data);
    setValues(productToForm(result.data));
    return null;
  };

  const restore = () =>
    run(async () => {
      if (product === null) return;
      setFormError(null);
      const result = await request<AdminProduct>(
        apiFetch,
        `/admin/products/${encodeURIComponent(product.id)}/restore`,
        jsonInit('POST'),
      );
      if (!result.ok) {
        setFormError(writeErrorMessage(dict, locale, result.error));
        return;
      }
      setProduct(result.data);
      setValues(productToForm(result.data));
      setNotice(copy.restore.done);
    });

  const nameForTitle = product === null ? '' : localName(product, locale);

  return (
    <div className="flex flex-col gap-4">
      <Link
        href={`/${locale}/catalog/products`}
        className="inline-flex min-h-11 items-center font-medium underline underline-offset-2"
      >
        ← {copy.back}
      </Link>
      <PageHeader
        title={product === null ? copy.titleNew : nameForTitle}
        subtitle={product === null ? undefined : copy.titleEdit}
        actions={
          product === null ? undefined : <ProductStatusBadge state={productState(product)} />
        }
      />

      {notice === null ? null : <Alert tone="success">{notice}</Alert>}
      {archived ? <Alert tone="warning">{copy.archivedBanner}</Alert> : null}
      {formError === null ? null : <Alert tone="error">{formError}</Alert>}

      <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <fieldset disabled={archived} className="flex min-w-0 flex-col gap-4">
          <section className={CARD} aria-labelledby="sec-identity">
            <h2 id="sec-identity" className="text-lg font-semibold">
              {copy.sections.identity}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={copy.fields.sku}
                error={errorFor('sku')}
                testId="product-sku"
                input={{
                  ...textInputAttrs(values.sku, (value) => {
                    clearServer('sku');
                    setValues((previous) => ({
                      ...previous,
                      sku: value,
                      // The slug follows the SKU until the admin writes their own.
                      slug: slugTouched ? previous.slug : slugFromSku(value),
                    }));
                    setNotice(null);
                  }),
                  autoCapitalize: 'characters',
                  autoCorrect: 'off',
                  spellCheck: false,
                  maxLength: 64,
                  name: 'sku',
                }}
              />
              <TextField
                label={copy.fields.slug}
                hint={product === null ? copy.fields.slugHint : undefined}
                error={errorFor('slug')}
                testId="product-slug"
                input={{
                  ...textInputAttrs(values.slug, (value) => {
                    clearServer('slug');
                    setSlugTouched(true);
                    set('slug', value);
                  }),
                  autoCapitalize: 'none',
                  autoCorrect: 'off',
                  spellCheck: false,
                  maxLength: 128,
                  name: 'slug',
                }}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <fieldset className="flex min-w-0 flex-col gap-4">
                <legend className="mb-1 font-semibold">{copy.languageUz}</legend>
                <TextField
                  label={copy.fields.nameUz}
                  error={errorFor('name_uz')}
                  testId="product-name-uz"
                  input={{
                    type: 'text',
                    lang: 'uz',
                    maxLength: 255,
                    value: values.name_uz,
                    name: 'name_uz',
                    onChange: (event) => {
                      clearServer('name_uz');
                      set('name_uz', event.target.value);
                    },
                  }}
                />
                <TextAreaField
                  label={copy.fields.descriptionUz}
                  optionalLabel={dict.common.optional}
                  error={errorFor('description_uz')}
                  testId="product-description-uz"
                  textarea={{
                    lang: 'uz',
                    rows: 4,
                    maxLength: 5000,
                    value: values.description_uz,
                    name: 'description_uz',
                    onChange: (event) => set('description_uz', event.target.value),
                  }}
                />
              </fieldset>
              <fieldset className="flex min-w-0 flex-col gap-4">
                <legend className="mb-1 font-semibold">{copy.languageRu}</legend>
                <TextField
                  label={copy.fields.nameRu}
                  error={errorFor('name_ru')}
                  testId="product-name-ru"
                  input={{
                    type: 'text',
                    lang: 'ru',
                    maxLength: 255,
                    value: values.name_ru,
                    name: 'name_ru',
                    onChange: (event) => {
                      clearServer('name_ru');
                      set('name_ru', event.target.value);
                    },
                  }}
                />
                <TextAreaField
                  label={copy.fields.descriptionRu}
                  optionalLabel={dict.common.optional}
                  error={errorFor('description_ru')}
                  testId="product-description-ru"
                  textarea={{
                    lang: 'ru',
                    rows: 4,
                    maxLength: 5000,
                    value: values.description_ru,
                    name: 'description_ru',
                    onChange: (event) => set('description_ru', event.target.value),
                  }}
                />
              </fieldset>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-2">
                <SelectField
                  label={copy.fields.category}
                  value={values.category_id}
                  onChange={(value) => {
                    clearServer('category_id');
                    set('category_id', value);
                  }}
                  options={categoryOptions}
                  placeholder={copy.fields.categoryPlaceholder}
                  error={errorFor('category_id')}
                  testId="product-category"
                />
                {categories.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {copy.noCategories}{' '}
                    <Link href={`/${locale}/catalog/categories`} className={TEXT_LINK}>
                      {dict.nav.items.categories}
                    </Link>
                  </p>
                ) : null}
              </div>
              <SelectField
                label={copy.fields.unit}
                value={values.unit}
                onChange={(value) => set('unit', value as ProductUnit)}
                options={unitOptions}
                error={errorFor('unit')}
                testId="product-unit"
              />
            </div>
          </section>

          <section className={CARD} aria-labelledby="sec-pricing">
            <h2 id="sec-pricing" className="text-lg font-semibold">
              {copy.sections.pricing}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={copy.fields.price}
                error={errorFor('price_uzs')}
                hint={typeof price === 'number' ? formatUZS(price, locale) : undefined}
                testId="price-input"
                input={{
                  ...integerInputAttrs(values.price, (value) => {
                    clearServer('price_uzs', 'old_price_uzs');
                    set('price', value);
                  }),
                  name: 'price_uzs',
                }}
              />
              <TextField
                label={copy.fields.oldPrice}
                optionalLabel={dict.common.optional}
                hint={copy.fields.oldPriceHint}
                error={errorFor('old_price_uzs')}
                testId="old-price-input"
                input={{
                  ...integerInputAttrs(values.old_price, (value) => {
                    clearServer('old_price_uzs');
                    set('old_price', value);
                  }),
                  name: 'old_price_uzs',
                }}
              />
              <TextField
                label={copy.fields.stock}
                optionalLabel={dict.common.optional}
                hint={copy.fields.stockHint}
                error={errorFor('stock_quantity')}
                testId="stock-input"
                input={{
                  ...integerInputAttrs(values.stock, (value) => {
                    clearServer('stock_quantity');
                    set('stock', value);
                  }),
                  name: 'stock_quantity',
                }}
              />
              <TextField
                label={copy.fields.sortOrder}
                hint={copy.fields.sortOrderHint}
                error={errorFor('sort_order')}
                testId="sort-order-input"
                input={{
                  ...integerInputAttrs(
                    values.sort_order,
                    (value) => {
                      clearServer('sort_order');
                      set('sort_order', value);
                    },
                    { allowNegative: true },
                  ),
                  name: 'sort_order',
                }}
              />
            </div>
            <CheckboxField
              label={copy.fields.isActive}
              hint={copy.fields.isActiveHint}
              checked={values.is_active}
              onChange={(checked) => set('is_active', checked)}
              testId="product-active"
            />
          </section>

          <section className={CARD} aria-labelledby="sec-image">
            <h2 id="sec-image" className="text-lg font-semibold">
              {copy.sections.image}
            </h2>
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1 basis-64">
                <TextField
                  label={copy.fields.imageUrl}
                  optionalLabel={dict.common.optional}
                  hint={copy.fields.imageHint}
                  error={errorFor('image_url')}
                  testId="product-image-url"
                  input={{
                    type: 'url',
                    inputMode: 'url',
                    autoCapitalize: 'none',
                    autoCorrect: 'off',
                    spellCheck: false,
                    maxLength: 2048,
                    placeholder: 'https://',
                    value: values.image_url,
                    name: 'image_url',
                    onChange: (event) => {
                      clearServer('image_url');
                      set('image_url', event.target.value);
                    },
                  }}
                />
              </div>
              <div className="flex w-32 shrink-0 flex-col gap-1">
                <p className="text-sm font-medium">{copy.preview}</p>
                <ImagePlaceholder src={previewSrc} alt={copy.previewAlt} className="w-32" />
              </div>
            </div>
            {previewEnabled ? (
              previewSrc === null ? null : (
                <p className="text-sm text-muted-foreground">{copy.previewUnavailable}</p>
              )
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="image-preview-note">
                {copy.previewDisabled}
              </p>
            )}
          </section>
        </fieldset>

        {archived ? null : (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending} data-testid="save-button">
              {pending ? dict.common.saving : product === null ? copy.submitNew : copy.submitEdit}
            </Button>
          </div>
        )}
      </form>

      {product === null ? null : (
        <section className={CARD} aria-label={archived ? copy.restore.button : copy.archive.button}>
          {archived ? (
            <>
              <p className="text-muted-foreground">{copy.restore.hint}</p>
              <div>
                <Button
                  variant="secondary"
                  onClick={() => void restore()}
                  disabled={pending}
                  data-testid="restore-product"
                >
                  {copy.restore.button}
                </Button>
              </div>
            </>
          ) : (
            <div>
              <Button
                variant="secondary"
                onClick={(event) => setDialog({ opener: event.currentTarget })}
                disabled={pending}
                data-testid="archive-product"
              >
                {copy.archive.button}
              </Button>
            </div>
          )}
        </section>
      )}

      {dialog === null ? null : (
        <ConfirmDialog
          title={copy.archive.title}
          description={copy.archive.description}
          confirmLabel={copy.archive.confirm}
          onConfirm={archive}
          onClose={() => setDialog(null)}
          returnFocusTo={dialog.opener}
        />
      )}
    </div>
  );
}

/** Create (`id` omitted) or edit a product. Loads the category list, and the product when editing. */
export function ProductFormView({ id }: { id?: string }) {
  const { dict, locale } = useI18n();
  const params = useSearchParams();
  const categories = useApiResource<AdminCategoryList>('/admin/categories');
  const product = useApiResource<AdminProduct>(
    id === undefined ? null : `/admin/products/${encodeURIComponent(id)}`,
  );

  const back = (
    <Link
      href={`/${locale}/catalog/products`}
      className="inline-flex min-h-11 items-center font-medium underline underline-offset-2"
    >
      ← {dict.products.form.back}
    </Link>
  );

  const loading =
    categories.status === 'loading' || (id !== undefined && product.status === 'loading');
  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <div role="status" aria-label={dict.products.form.loading}>
          <FormSkeleton />
        </div>
      </div>
    );
  }

  const failure = categories.error ?? product.error;
  if (failure !== null) {
    if (failure.code === 'forbidden') return <PermissionDenied />;
    return (
      <div className="flex flex-col gap-4">
        {back}
        {failure.code === 'product_not_found' || failure.code === 'not_found' ? (
          <EmptyState
            title={dict.products.form.notFoundTitle}
            description={dict.products.form.notFoundMessage}
          />
        ) : (
          <ErrorState
            title={dict.errors.title}
            description={readErrorMessage(dict, failure)}
            retryLabel={dict.errors.retry}
            onRetry={() => {
              categories.reload();
              product.reload();
            }}
          />
        )}
      </div>
    );
  }

  const loaded = product.data;
  return (
    <ProductForm
      // A new key after every reload re-initialises the form from the fresh product.
      key={`${loaded?.id ?? 'new'}|${loaded?.updated_at ?? ''}`}
      categories={categories.data?.items ?? []}
      product={loaded}
      created={params.get('created') === '1'}
      onReload={() => product.reload()}
    />
  );
}
