"use client";

/**
 * CSV upload + pin-drop controls for the T4.5 admin target-import page.
 * A small client island alongside the Server Component page, mirroring
 * `app/host/campaigns/[id]/review/ReviewActions.tsx` (T4.2) — the
 * interactive part is split out so the page itself stays a Server
 * Component that can resolve the staff session and guard access without
 * a client round-trip.
 *
 * Both actions POST to the one route this card's Files list asks for
 * (`/api/admin/campaigns/[id]/targets/import`), which is the only place
 * a target actually gets created (constitution §6) — this component only
 * collects input and reports the result. Newly created targets show up
 * on the reused `CampaignMap` (T4.4) below via its own 5-10s poll; this
 * form does not need to push state into that component directly.
 */
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

interface RowError {
  line: number;
  raw: string;
  reason: string;
}

interface TargetSummary {
  id: string;
  label: string;
}

interface ImportReport {
  created: TargetSummary[];
  errors: RowError[];
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export function TargetImportForm({ campaignId }: { campaignId: string }) {
  const [csvBanner, setCsvBanner] = useState<string | null>(null);
  const [csvReport, setCsvReport] = useState<ImportReport | null>(null);
  const [csvPending, setCsvPending] = useState(false);

  const [pinLabel, setPinLabel] = useState("");
  const [pinLat, setPinLat] = useState("");
  const [pinLong, setPinLong] = useState("");
  const [pinBanner, setPinBanner] = useState<string | null>(null);
  const [pinPending, setPinPending] = useState(false);

  async function handleCsvFile(file: File): Promise<void> {
    setCsvPending(true);
    setCsvBanner(null);
    setCsvReport(null);
    try {
      const csv = await file.text();
      const res = await fetch(
        `/api/admin/campaigns/${campaignId}/targets/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "csv", csv }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        ImportReport | ErrorBody | null;
      if (!res.ok) {
        setCsvBanner(
          (body as ErrorBody | null)?.error?.message ??
            "Could not import this CSV.",
        );
        return;
      }
      setCsvReport(body as ImportReport);
    } catch {
      setCsvBanner(
        "Could not import this CSV. Check your connection and try again.",
      );
    } finally {
      setCsvPending(false);
    }
  }

  async function handlePinDrop(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPinPending(true);
    setPinBanner(null);
    try {
      const res = await fetch(
        `/api/admin/campaigns/${campaignId}/targets/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "pin",
            label: pinLabel,
            lat: Number(pinLat),
            long: Number(pinLong),
          }),
        },
      );
      const body = (await res.json().catch(() => null)) as ErrorBody | null;
      if (!res.ok) {
        setPinBanner(body?.error?.message ?? "Could not add this pin.");
        return;
      }
      setPinLabel("");
      setPinLat("");
      setPinLong("");
      setPinBanner("Pin added.");
    } catch {
      setPinBanner(
        "Could not add this pin. Check your connection and try again.",
      );
    } finally {
      setPinPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="target-import-form">
      <section className="flex flex-col gap-2 rounded-lg border border-input p-4">
        <h2 className="text-sm font-semibold">Import CSV</h2>
        <p className="text-xs text-muted-foreground">
          Columns: label, lat, long
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          data-testid="csv-file-input"
          disabled={csvPending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void handleCsvFile(file);
          }}
        />
        {csvBanner ? (
          <p className="text-sm text-destructive" data-testid="csv-banner">
            {csvBanner}
          </p>
        ) : null}
        {csvReport ? (
          <div data-testid="csv-report" className="text-sm">
            <p data-testid="csv-created-count">
              {csvReport.created.length} target(s) created.
            </p>
            {csvReport.errors.length > 0 ? (
              <ul
                data-testid="csv-error-report"
                className="mt-1 list-disc pl-5 text-destructive"
              >
                {csvReport.errors.map((rowError) => (
                  <li key={rowError.line}>
                    Line {rowError.line}: {rowError.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-input p-4">
        <h2 className="text-sm font-semibold">Drop a pin</h2>
        <form
          data-testid="pin-drop-form"
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => void handlePinDrop(event)}
        >
          <label className="flex flex-col text-xs">
            Label
            <input
              className="rounded-md border border-input px-2 py-1 text-sm"
              data-testid="pin-label-input"
              value={pinLabel}
              onChange={(event) => setPinLabel(event.target.value)}
              required
            />
          </label>
          <label className="flex flex-col text-xs">
            Latitude
            <input
              className="rounded-md border border-input px-2 py-1 text-sm"
              data-testid="pin-lat-input"
              value={pinLat}
              onChange={(event) => setPinLat(event.target.value)}
              inputMode="decimal"
              required
            />
          </label>
          <label className="flex flex-col text-xs">
            Longitude
            <input
              className="rounded-md border border-input px-2 py-1 text-sm"
              data-testid="pin-long-input"
              value={pinLong}
              onChange={(event) => setPinLong(event.target.value)}
              inputMode="decimal"
              required
            />
          </label>
          <Button
            type="submit"
            disabled={pinPending}
            data-testid="pin-drop-submit"
          >
            Add pin
          </Button>
        </form>
        {pinBanner ? (
          <p className="text-sm" data-testid="pin-banner">
            {pinBanner}
          </p>
        ) : null}
      </section>
    </div>
  );
}
