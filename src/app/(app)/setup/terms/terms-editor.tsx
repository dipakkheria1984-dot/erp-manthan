"use client";

import { useState } from "react";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Field, FormActions, FormGrid, Input, Textarea } from "@/components/ui";
import { toDateInput } from "@/lib/dates";
import { saveTermsVersionAction } from "./actions";

/**
 * The stored content is author-written HTML from this admin-only editor, so it
 * is rendered directly. Nothing user-submitted ever reaches this field.
 */
export function TermsPreview({ html }: { html: string }) {
  return (
    <div
      className="prose-sm max-w-none space-y-2 text-sm [&_h3]:font-semibold [&_li]:ml-5 [&_li]:list-item [&_ol]:list-decimal [&_ul]:list-disc"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function TermsEditor({
  document,
  documentLabel,
  defaultTitle,
  defaultContent,
}: {
  document: string;
  documentLabel: string;
  defaultTitle: string;
  defaultContent: string;
}) {
  const [content, setContent] = useState(defaultContent);
  // Two editors share the page, so every field needs an id unique to its document.
  const idFor = (field: string) => `${document.toLowerCase()}-${field}`;

  return (
    <ActionForm action={saveTermsVersionAction}>
      {(state) => (
        <>
          <input type="hidden" name="document" value={document} />
          <FormGrid>
            <Field label="Title" htmlFor={idFor("title")} required error={fieldError(state, "title")}>
              <Input id={idFor("title")} name="title" defaultValue={defaultTitle} required />
            </Field>
            <Field
              label="Effective from"
              htmlFor={idFor("effectiveFrom")}
              required
              hint={`${documentLabel}s printed on or after this date use the new version.`}
              error={fieldError(state, "effectiveFrom")}
            >
              <Input
                id={idFor("effectiveFrom")}
                name="effectiveFrom"
                type="date"
                defaultValue={toDateInput(new Date())}
                required
              />
            </Field>
          </FormGrid>

          <Field label="Content" htmlFor={idFor("content")} required error={fieldError(state, "content")}>
            <Textarea
              id={idFor("content")}
              name="content"
              rows={14}
              className="font-mono text-xs"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
            />
          </Field>

          {content.trim() ? (
            <div className="rounded-md border border-border bg-background p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Preview</p>
              <TermsPreview html={content} />
            </div>
          ) : null}

          <FormActions>
            <SubmitButton pendingLabel="Saving…">Save as new {documentLabel.toLowerCase()} version</SubmitButton>
          </FormActions>
        </>
      )}
    </ActionForm>
  );
}
