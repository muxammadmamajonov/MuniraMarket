'use client';

import type {
  AdminCategory,
  AdminCategoryList,
  CategoryCreateRequest,
  CategoryUpdateRequest,
} from '@muniramarket/contracts';
import { Button, EmptyState } from '@muniramarket/ui';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import type { FieldKey } from '@/i18n/dictionaries/sections/shared';
import { writeErrorMessage } from '@/lib/api/error-messages';
import { FORM_LEVEL, fieldErrorsFrom } from '@/lib/api/field-errors';
import { jsonInit, request } from '@/lib/api/request';
import {
  categoryTree,
  descendantIds,
  indentedLabel,
  isValidImageUrl,
  localName,
} from '@/lib/catalog';
import { formatCount } from '@/lib/format';
import { parseIntegerField } from '@/lib/numbers';
import { SLUG_PATTERN } from '@/lib/slug';
import { useSession } from '@/lib/session';
import { useApiResource } from '@/lib/use-api-resource';
import { useSingleFlight } from '@/lib/use-single-flight';
import { Alert } from '../ui/alert';
import { CARD, CHIP, CHIP_OFF, CHIP_ON } from '../ui/classes';
import { ConfirmDialog } from '../ui/confirm-dialog';
import {
  CheckboxField,
  SelectField,
  TextField,
  integerInputAttrs,
  textInputAttrs,
} from '../ui/fields';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { ResourceView } from '../ui/resource-view';

type Errors = Partial<Record<FieldKey, string>>;

interface FormState {
  slug: string;
  name_uz: string;
  name_ru: string;
  parent_id: string;
  sort_order: string;
  is_active: boolean;
  image_url: string;
}

function toForm(category: AdminCategory | null): FormState {
  return {
    slug: category?.slug ?? '',
    name_uz: category?.name_uz ?? '',
    name_ru: category?.name_ru ?? '',
    parent_id: category?.parent_id ?? '',
    sort_order: String(category?.sort_order ?? 0),
    is_active: category?.is_active ?? true,
    image_url: category?.image_url ?? '',
  };
}

function CategoryDialog({
  category,
  all,
  opener,
  onClose,
  onSaved,
}: {
  category: AdminCategory | null;
  all: readonly AdminCategory[];
  opener: HTMLElement | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { dict, locale } = useI18n();
  const copy = dict.categories.dialog;
  const { apiFetch } = useSession();
  const { pending, run } = useSingleFlight();
  const [form, setForm] = useState<FormState>(toForm(category));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const forbidden = useMemo(
    () => (category === null ? new Set<string>() : descendantIds(all, category.id)),
    [all, category],
  );
  const parentOptions = categoryTree(all, locale)
    .filter(({ category: candidate }) => !forbidden.has(candidate.id))
    .map(({ category: candidate, depth }) => ({
      value: candidate.id,
      label: indentedLabel(localName(candidate, locale), depth),
    }));

  const set = <K extends keyof FormState>(key: K, value: FormState[K], field?: FieldKey) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    if (field !== undefined) setErrors((previous) => ({ ...previous, [field]: undefined }));
  };

  const validate = (): Errors => {
    const found: Errors = {};
    const need = (key: 'name_uz' | 'name_ru') => {
      const text = form[key].trim();
      if (text === '') found[key] = dict.validation.required;
      else if (text.length > 255) found[key] = dict.validation.fields[key];
    };
    need('name_uz');
    need('name_ru');
    if (form.slug.trim() === '') found.slug = dict.validation.required;
    else if (!SLUG_PATTERN.test(form.slug.trim()) || form.slug.trim().length > 128) {
      found.slug = dict.validation.fields.slug;
    }
    if (typeof parseIntegerField(form.sort_order, { min: -100000, max: 100000 }) !== 'number') {
      found.sort_order = dict.validation.fields.sort_order;
    }
    if (form.image_url.trim() !== '' && !isValidImageUrl(form.image_url.trim())) {
      found.image_url = dict.validation.fields.image_url;
    }
    return found;
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      queueMicrotask(() =>
        formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    const sort = parseIntegerField(form.sort_order, { min: -100000, max: 100000 }) as number;
    const body = {
      slug: form.slug.trim(),
      name_uz: form.name_uz.trim(),
      name_ru: form.name_ru.trim(),
      parent_id: form.parent_id === '' ? null : form.parent_id,
      sort_order: sort,
      is_active: form.is_active,
      image_url: form.image_url.trim() === '' ? null : form.image_url.trim(),
    };

    void run(async () => {
      const result =
        category === null
          ? await request<AdminCategory>(
              apiFetch,
              '/admin/categories',
              jsonInit('POST', body satisfies CategoryCreateRequest),
            )
          : await request<AdminCategory>(
              apiFetch,
              `/admin/categories/${encodeURIComponent(category.id)}`,
              jsonInit('PATCH', body satisfies CategoryUpdateRequest),
            );
      if (result.ok) {
        onSaved(category === null ? dict.categories.created : dict.categories.saved);
        return;
      }
      const { error } = result;
      if (error.code === 'slug_taken') setErrors({ slug: dict.apiErrors.codes.slug_taken });
      else if (error.code === 'category_cycle') {
        setErrors({ parent_id: dict.apiErrors.codes.category_cycle });
      } else if (error.code === 'category_not_found') {
        setErrors({ parent_id: dict.apiErrors.codes.category_not_found });
      } else if (error.code === 'validation_error') {
        const fields = fieldErrorsFrom(error);
        const next: Errors = {};
        for (const name of Object.keys(fields)) {
          if (name !== FORM_LEVEL && name in dict.validation.fields) {
            next[name as FieldKey] = dict.validation.fields[name as FieldKey];
          }
        }
        setErrors(next);
        setFormError(dict.validation.summary);
      } else {
        setFormError(writeErrorMessage(dict, locale, error));
      }
    });
  };

  return (
    <Modal
      title={category === null ? copy.titleNew : copy.titleEdit}
      onClose={onClose}
      dismissible={!pending}
      returnFocusTo={opener}
    >
      <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
        {formError === null ? null : <Alert tone="error">{formError}</Alert>}
        <TextField
          label={copy.nameUz}
          error={errors.name_uz ?? null}
          testId="category-name-uz"
          input={{
            type: 'text',
            lang: 'uz',
            maxLength: 255,
            value: form.name_uz,
            onChange: (event) => set('name_uz', event.target.value, 'name_uz'),
          }}
        />
        <TextField
          label={copy.nameRu}
          error={errors.name_ru ?? null}
          testId="category-name-ru"
          input={{
            type: 'text',
            lang: 'ru',
            maxLength: 255,
            value: form.name_ru,
            onChange: (event) => set('name_ru', event.target.value, 'name_ru'),
          }}
        />
        <TextField
          label={copy.slug}
          error={errors.slug ?? null}
          testId="category-slug"
          input={{
            ...textInputAttrs(form.slug, (value) => set('slug', value, 'slug')),
            autoCapitalize: 'none',
            autoCorrect: 'off',
            spellCheck: false,
            maxLength: 128,
          }}
        />
        <SelectField
          label={copy.parent}
          value={form.parent_id}
          onChange={(value) => set('parent_id', value, 'parent_id')}
          options={parentOptions}
          placeholder={copy.noParent}
          error={errors.parent_id ?? null}
          testId="category-parent"
        />
        <TextField
          label={copy.sortOrder}
          error={errors.sort_order ?? null}
          testId="category-sort-order"
          input={integerInputAttrs(
            form.sort_order,
            (value) => set('sort_order', value, 'sort_order'),
            {
              allowNegative: true,
            },
          )}
        />
        <TextField
          label={copy.imageUrl}
          optionalLabel={dict.common.optional}
          hint={copy.imageHint}
          error={errors.image_url ?? null}
          input={{
            type: 'url',
            inputMode: 'url',
            autoCapitalize: 'none',
            autoCorrect: 'off',
            spellCheck: false,
            maxLength: 2048,
            placeholder: 'https://',
            value: form.image_url,
            onChange: (event) => set('image_url', event.target.value, 'image_url'),
          }}
        />
        <CheckboxField
          label={copy.isActive}
          checked={form.is_active}
          onChange={(checked) => set('is_active', checked)}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {dict.common.cancel}
          </Button>
          <Button type="submit" disabled={pending} data-testid="category-save">
            {pending ? dict.common.saving : category === null ? copy.submitNew : copy.submitEdit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

type DialogState =
  | { kind: 'form'; category: AdminCategory | null; opener: HTMLElement | null }
  | { kind: 'delete'; category: AdminCategory; opener: HTMLElement | null };

/** Category tree: create, edit (incl. parent), activate/deactivate, delete (only when empty). */
export function CategoriesView() {
  const { dict, locale } = useI18n();
  const copy = dict.categories;
  const { apiFetch } = useSession();
  const resource = useApiResource<AdminCategoryList>('/admin/categories');
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const { pending, run } = useSingleFlight();

  const rows = useMemo(
    () => categoryTree(resource.data?.items ?? [], locale),
    [resource.data, locale],
  );

  const toggle = (category: AdminCategory) =>
    run(async () => {
      setRowError(null);
      setNotice(null);
      const result = await request<AdminCategory>(
        apiFetch,
        `/admin/categories/${encodeURIComponent(category.id)}`,
        jsonInit('PATCH', { is_active: !category.is_active }),
      );
      if (result.ok) resource.reload();
      else setRowError(writeErrorMessage(dict, locale, result.error));
    });

  const remove = async (category: AdminCategory): Promise<string | null> => {
    const result = await request(
      apiFetch,
      `/admin/categories/${encodeURIComponent(category.id)}`,
      jsonInit('DELETE'),
    );
    if (!result.ok) return writeErrorMessage(dict, locale, result.error);
    setNotice(copy.deleted);
    resource.reload();
    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={copy.title}
        actions={
          <Button
            onClick={(event) =>
              setDialog({ kind: 'form', category: null, opener: event.currentTarget })
            }
            data-testid="new-category"
          >
            {copy.newCategory}
          </Button>
        }
      />
      {notice === null ? null : <Alert tone="success">{notice}</Alert>}
      {rowError === null ? null : <Alert tone="error">{rowError}</Alert>}

      <ResourceView resource={resource} loadingLabel={copy.loading}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={copy.empty} />
          ) : (
            <ul aria-label={copy.list} className="flex flex-col gap-2">
              {rows.map(({ category, depth }) => (
                <li
                  key={category.id}
                  data-testid="category-row"
                  className={`${CARD} sm:flex-row sm:items-center sm:justify-between`}
                  style={{ marginInlineStart: `${Math.min(depth, 5) * 1.25}rem` }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold break-words">{localName(category, locale)}</p>
                    <p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
                      <span className="font-mono">{category.slug}</span> ·{' '}
                      {formatMessage(copy.productCount, {
                        count: formatCount(category.product_count),
                      })}{' '}
                      ·{' '}
                      {formatMessage(copy.childCount, { count: formatCount(category.child_count) })}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      aria-pressed={category.is_active}
                      aria-label={formatMessage(copy.toggleLabel, {
                        name: localName(category, locale),
                      })}
                      disabled={pending}
                      onClick={() => void toggle(category)}
                      className={`${CHIP} ${category.is_active ? CHIP_ON : CHIP_OFF} disabled:opacity-50`}
                    >
                      {category.is_active ? dict.common.active : dict.common.inactive}
                    </button>
                    <Button
                      variant="secondary"
                      onClick={(event) =>
                        setDialog({ kind: 'form', category, opener: event.currentTarget })
                      }
                    >
                      {copy.edit}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={(event) =>
                        setDialog({ kind: 'delete', category, opener: event.currentTarget })
                      }
                      aria-label={`${copy.remove}: ${localName(category, locale)}`}
                    >
                      {copy.remove}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>

      {dialog?.kind === 'form' ? (
        <CategoryDialog
          category={dialog.category}
          all={resource.data?.items ?? []}
          opener={dialog.opener}
          onClose={() => setDialog(null)}
          onSaved={(message) => {
            setDialog(null);
            setNotice(message);
            resource.reload();
          }}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <ConfirmDialog
          title={copy.delete.title}
          description={formatMessage(copy.delete.description, {
            name: localName(dialog.category, locale),
          })}
          confirmLabel={copy.delete.confirm}
          onConfirm={() => remove((dialog as Extract<DialogState, { kind: 'delete' }>).category)}
          onClose={() => setDialog(null)}
          returnFocusTo={dialog.opener}
        />
      ) : null}
    </div>
  );
}
