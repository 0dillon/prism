"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { SelectField } from "@/components/SelectField";
import { TextField } from "@/components/TextField";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";
import type { CreatedInvite } from "@/lib/orgs/service";

/**
 * Invites a teacher (or another principal) by email. Until an email provider is set up the
 * link is shown here to be passed on; it works once, for the invited address, for 7 days.
 */
export function InviteForm({ orgId }: { orgId: string }) {
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedInvite[]>([]);
  const formRef = useRef<HTMLFormElement>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const role = String(data.get("role") ?? "teacher");
    if (!email) {
      const message = "Enter an email address.";
      setError(message);
      announce(message, "assertive");
      return;
    }
    setError(undefined);
    setBusy(true);
    const result = await sendJson<CreatedInvite>(`/api/orgs/${orgId}/invites`, { email, role });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    setCreated((list) => [result.data, ...list]);
    formRef.current?.reset();
    announce(`Invitation created for ${result.data.email}.`);
  };

  return (
    <section aria-labelledby="invite-heading" className="flex flex-col gap-4">
      <h2 id="invite-heading" className="text-xl font-semibold">
        Invite teachers
      </h2>
      <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <TextField
          label="Email address"
          name="email"
          type="email"
          autoComplete="off"
          disabled={busy}
          error={error}
        />
        <SelectField
          label="Role"
          name="role"
          defaultValue="teacher"
          disabled={busy}
          options={[
            { value: "teacher", label: "Teacher" },
            { value: "principal", label: "Principal" },
          ]}
        />
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create invitation"}
          </Button>
        </div>
      </form>

      {created.length > 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-muted">
            Email is not set up yet, so share each link yourself. A link works once, only for the
            address it was made for, and expires in 7 days.
          </p>
          <ul className="flex flex-col gap-3">
            {created.map((invite) => (
              <li
                key={invite.invitationId}
                className="border-line flex flex-col gap-2 rounded-lg border p-3"
              >
                <p>
                  <strong>{invite.email}</strong> as {invite.role}
                </p>
                <input
                  readOnly
                  aria-label={`Invitation link for ${invite.email}`}
                  value={invite.link}
                  onFocus={(event) => event.currentTarget.select()}
                  className="border-line bg-background min-h-11 w-full rounded-md border px-3 py-2 font-mono text-sm"
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
