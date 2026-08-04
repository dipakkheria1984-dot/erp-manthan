"use client";

import { useRef, useState } from "react";
import type { Institute } from "@/generated/prisma/client";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Card, Field, FormActions, Input } from "@/components/ui";

import { removeInstituteLogoAction, uploadInstituteLogoAction } from "./actions";

/**
 * Institute logo upload.
 *
 * The image is stored under UPLOAD_DIR like every other upload and served back
 * through /api/institute/logo, so the same database works on any machine — the
 * old approach, a path typed by the admin, only ever resolved on the one host
 * where it was typed.
 */
export function InstituteLogoCard({ institute }: { institute: Institute | null }) {
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const stored = institute?.logoStoragePath
    ? `/api/institute/logo?v=${institute.logoUpdatedAt?.getTime() ?? 0}`
    : null;
  const shown = preview ?? stored;

  return (
    <Card
      title="Logo"
      description="Printed at the left of the letterhead on receipts, admission forms, the welcome kit and report exports."
    >
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-lg border border-dashed border-border bg-background p-2">
          {shown ? (
            // Served from an authenticated route, which next/image's optimiser
            // cannot fetch, and it doubles as the local object-URL preview.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shown} alt="Institute logo" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="px-2 text-center text-xs text-muted">No logo</span>
          )}
        </div>

        <div className="min-w-64 flex-1">
          <ActionForm
            action={uploadInstituteLogoAction}
            onSuccess={() => {
              // The stored URL now carries a fresh version, so drop the local
              // object URL and let the saved image be the one on display.
              setPreview(null);
              if (fileRef.current) fileRef.current.value = "";
            }}
          >
            {(state) => (
              <>
                <Field
                  label={stored ? "Replace logo" : "Upload logo"}
                  htmlFor="logo"
                  hint="PNG or JPG. A square image around 400×400 reproduces best; transparent PNGs keep their transparency."
                  error={fieldError(state, "logo")}
                >
                  <Input
                    id="logo"
                    name="logo"
                    type="file"
                    accept="image/png,image/jpeg"
                    ref={fileRef}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      setPreview(file ? URL.createObjectURL(file) : null);
                    }}
                    className="file:mr-3 file:rounded file:border-0 file:bg-background file:px-3 file:py-1 file:text-sm"
                  />
                </Field>
                <FormActions>
                  <SubmitButton pendingLabel="Uploading…" disabled={!institute}>
                    {stored ? "Replace logo" : "Upload logo"}
                  </SubmitButton>
                </FormActions>
              </>
            )}
          </ActionForm>

          {stored ? (
            <div className="mt-4 border-t border-border pt-4">
              <p className="mb-2 text-xs text-muted">
                {institute?.logoFileName}
                {institute?.logoSizeBytes ? ` · ${Math.round(institute.logoSizeBytes / 1024)} KB` : null}
              </p>
              <ActionForm action={removeInstituteLogoAction}>
                <SubmitButton variant="secondary" size="sm" pendingLabel="Removing…">
                  Remove logo
                </SubmitButton>
              </ActionForm>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
