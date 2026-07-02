"use client";

/**
 * Approve/Reject controls for one review-queue card (T4.2, PRD FR-R2:
 * "Approve/Reject + reason code"). POSTs to the thin decision route
 * (`app/api/host/campaigns/[id]/submissions/[sid]/decision/route.ts`),
 * which is the only place the actual decision logic runs
 * (`lib/review/decision.ts`) — this component only collects a reason code
 * and reports the result, per constitution §6.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface ReviewActionsProps {
  campaignId: string;
  submissionId: string;
}

interface DecisionErrorBody {
  error?: { code?: string; message?: string };
}

export function ReviewActions({
  campaignId,
  submissionId,
}: ReviewActionsProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decided, setDecided] = useState<"approved" | "rejected" | null>(null);

  async function decide(action: "approve" | "reject", reasonCode?: string) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/host/campaigns/${campaignId}/submissions/${submissionId}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, reasonCode }),
        },
      );
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => null)) as DecisionErrorBody | null;
        setError(body?.error?.message ?? "Something went wrong.");
        return;
      }
      setDecided(action === "approve" ? "approved" : "rejected");
    } finally {
      setPending(false);
    }
  }

  function handleReject() {
    // Card requirement 3/4: reject requires a reason code, which is
    // player-visible (`lib/review/decision.ts`'s `rejectSubmission`
    // throws `ReasonRequiredError` server-side if this is ever bypassed —
    // this prompt is a UX nicety, not the enforcement point, per
    // constitution §2's "hiding a button is not security").
    const reasonCode = window.prompt("Reason for rejecting this submission:");
    if (!reasonCode) return;
    void decide("reject", reasonCode);
  }

  if (decided) {
    return (
      <Badge
        variant={decided === "approved" ? "default" : "destructive"}
        className="w-fit"
        data-testid="review-decided"
      >
        {decided === "approved" ? "Approved." : "Rejected."}
      </Badge>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        disabled={pending}
        onClick={() => void decide("approve")}
        data-testid="approve-button"
      >
        Approve
      </Button>
      <Button
        type="button"
        variant="destructive"
        disabled={pending}
        onClick={handleReject}
        data-testid="reject-button"
      >
        Reject
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
