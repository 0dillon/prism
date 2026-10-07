"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { TextArea } from "@/components/TextArea";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";
import type { AddStudentsReport } from "@/lib/classrooms/students";

interface AddStudentsProps {
  classroomId: string;
  joinCode: string;
  archived: boolean;
}

/**
 * Three ways to fill a class: paste email addresses, upload a CSV, or give students the
 * class code. A report lists any rows that could not be used, with their line numbers.
 */
export function AddStudents({ classroomId, joinCode: initialCode, archived }: AddStudentsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [report, setReport] = useState<AddStudentsReport | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState(initialCode);
  const [csv, setCsv] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const submit = async (body: { emails?: string; csv?: string }) => {
    setBusy(true);
    setError(undefined);
    setReport(null);
    const result = await sendJson<AddStudentsReport>(
      `/api/classrooms/${classroomId}/students`,
      body,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    setReport(result.data);
    const { added, already, rejected } = result.data;
    announce(
      `${added} added, ${already} already in the class` +
        (rejected.length ? `, ${rejected.length} could not be used.` : "."),
    );
    if (added > 0) {
      formRef.current?.reset();
      setCsv(null);
      setFileName(null);
      router.refresh();
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const emails = String(new FormData(event.currentTarget).get("emails") ?? "");
    if (csv !== null) return submit({ csv });
    if (!emails.trim()) {
      const message = "Paste some email addresses or choose a CSV file.";
      setError(message);
      announce(message, "assertive");
      return;
    }
    return submit({ emails });
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setCsv(await file.text());
    setFileName(file.name);
    announce(`Selected ${file.name}.`);
  };

  const newCode = async () => {
    setBusy(true);
    const result = await sendJson<{ joinCode: string }>(
      `/api/classrooms/${classroomId}/join-code`,
      {},
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    setJoinCode(result.data.joinCode);
    announce(`The new class code is ${result.data.joinCode.split("").join(" ")}.`);
  };

  return (
    <section aria-labelledby="add-students-heading" className="flex flex-col gap-6">
      <h2 id="add-students-heading" className="text-xl font-semibold">
        Add students
      </h2>

      <div className="flex flex-col gap-2">
        <h3 className="font-semibold">With a class code</h3>
        <p className="text-muted">
          Students sign in, choose Join a class on their lessons page, and type this code.
        </p>
        <p className="flex flex-wrap items-center gap-3">
          <span className="sr-only">Class code: </span>
          <strong
            aria-label={`Class code ${joinCode.split("").join(" ")}`}
            className="font-mono text-2xl tracking-widest"
          >
            {joinCode}
          </strong>
          <Button variant="secondary" onClick={newCode} disabled={busy}>
            Make a new code
          </Button>
        </p>
      </div>

      {archived ? (
        <p className="text-muted">Restore this class to add students by email.</p>
      ) : (
        <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <h3 className="font-semibold">With email addresses</h3>
          <TextArea
            label="Email addresses"
            name="emails"
            hint="Separate them with commas, spaces or new lines. Students without an account join when they sign up with that address."
            rows={5}
            disabled={busy || csv !== null}
            error={error}
          />
          <div className="flex flex-col items-start gap-2">
            <label htmlFor="csv-file" className="font-medium">
              Or upload a CSV file
            </label>
            <p id="csv-hint" className="text-muted text-sm">
              One address per row, or a column named email.
            </p>
            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              aria-describedby="csv-hint"
              onChange={onFile}
              disabled={busy}
            />
            {fileName ? <p>Selected: {fileName}</p> : null}
          </div>
          <div>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add students"}
            </Button>
          </div>
        </form>
      )}

      {report ? (
        <div role="region" aria-label="Result of adding students" className="flex flex-col gap-3">
          <p>
            <strong>{report.added}</strong> added, <strong>{report.already}</strong> already in the
            class.
          </p>
          {report.rejected.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-danger font-medium">{report.rejected.length} could not be used:</p>
              <table className="border-line w-full border-collapse border text-left">
                <caption className="sr-only">Rows that could not be used</caption>
                <thead>
                  <tr>
                    <th scope="col" className="border-line border p-2">
                      Line
                    </th>
                    <th scope="col" className="border-line border p-2">
                      Value
                    </th>
                    <th scope="col" className="border-line border p-2">
                      Problem
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.rejected.map((row, index) => (
                    <tr key={index}>
                      <td className="border-line border p-2">{row.line ?? "–"}</td>
                      <td className="border-line border p-2 break-all">{row.value || "–"}</td>
                      <td className="border-line border p-2">{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
