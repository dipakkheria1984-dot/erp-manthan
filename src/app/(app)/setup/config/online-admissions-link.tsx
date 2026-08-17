"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui";

/**
 * The address to hand out, read from the browser rather than passed down.
 *
 * The server knows its own URL only from `APP_URL` or the Vercel-supplied
 * production host, and on a custom domain those can differ from what an
 * applicant would actually type. What the admin has in their address bar is the
 * host that really works, so that is what gets shown to copy.
 */
export function OnlineAdmissionsLink({ enabled }: { enabled: boolean }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const url = origin ? `${origin}/apply` : "/apply";

  return (
    <Alert tone={enabled ? "success" : "info"} title={enabled ? "The form is live" : "The form is not published"}>
      {enabled ? (
        <>
          Send applicants this address:{" "}
          <a href={url} target="_blank" rel="noreferrer" className="font-mono text-brand hover:underline">
            {url}
          </a>
        </>
      ) : (
        <>
          Tick the box above and save to publish{" "}
          <span className="font-mono">{url}</span>. Until then it answers every visitor with
          &ldquo;online admissions are closed&rdquo;.
        </>
      )}
    </Alert>
  );
}
