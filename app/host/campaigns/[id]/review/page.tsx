/**
 * Host review-queue page (T4.2) — PRD FR-R1…FR-R4. Server Component: reads
 * the queue directly from `lib/review/queue.ts` (constitution §6, domain
 * logic in `lib/`; a Server Component calling a `lib/` function directly
 * is the App Router's own idiom for a server-rendered, data-backed page —
 * no separate GET API route is needed just to feed this page, mirroring
 * how `app/api/admin/campaigns/[id]/route.ts` exists only because *other*
 * clients need HTTP access to the same read). Approve/Reject are a small
 * client island (`ReviewActions.tsx`) that POSTs to the one API route this
 * card's Files list does ask for.
 *
 * Auth: mirrors `app/api/admin/campaigns/[id]/route.ts`'s staff-session
 * resolution — a fresh `StaffPrincipal` per request (never anything cached
 * on the session/JWT, constitution §5) — then `lib/review/queue.ts`'s
 * `listReviewQueue` itself calls `requireCampaignAccess`, so a host
 * visiting another campaign's `/review` URL gets the same 403-equivalent
 * denial an API caller would (constitution §2: never a hidden button —
 * this page renders the denial as a message, not a silently empty list).
 */
import { auth } from "@/lib/auth/config";
import { resolveStaffPrincipal } from "@/lib/auth/staff";
import { ForbiddenError } from "@/lib/auth/guards";
import { listReviewQueue, type ReviewQueueItem } from "@/lib/review/queue";
import { PageShell } from "@/components/brand/PageShell";
import { Pill } from "@/components/brand/Pill";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ReviewActions } from "./ReviewActions";

interface PageParams {
  id: string;
}

interface PageProps {
  params: Promise<PageParams>;
}

function DeniedMessage({ message }: { message: string }) {
  return (
    <PageShell width="sm">
      <Card className="border-2 border-foreground/15">
        <CardContent>
          <p className="text-sm text-destructive" data-testid="review-denied">
            {message}
          </p>
        </CardContent>
      </Card>
    </PageShell>
  );
}

function ReviewCard({ item }: { item: ReviewQueueItem }) {
  const { submission, target, distanceM, player, photoUrl } = item;
  return (
    <li data-testid="review-card" data-submission-id={submission.id}>
      <Card className="border-2 border-foreground/15">
        {/* eslint-disable-next-line @next/next/no-img-element -- signed R2
            URLs are short-lived and per-request; next/image's remote-pattern
            allowlist doesn't fit a presigned, unique-per-view URL. */}
        <img
          src={photoUrl}
          alt={`Submission photo for target ${target.label}`}
          className="max-h-64 w-full object-cover"
        />
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle className="font-heading" data-testid="review-target">
            {target.label}
          </CardTitle>
          <span
            className="shrink-0"
            data-testid="review-distance"
            aria-label="Distance from target"
          >
            <Pill>
              {distanceM !== null ? `${distanceM.toFixed(1)} m` : "unknown"}
            </Pill>
          </span>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Canvasser</dt>
            <dd className="font-mono text-xs" data-testid="review-canvasser">
              {player?.email ?? "unknown"}
            </dd>
            <dt className="text-muted-foreground">Received</dt>
            <dd className="font-mono text-xs">
              {submission.receivedAt.toISOString()}
            </dd>
          </dl>
          <ul
            className="flex flex-wrap gap-2"
            data-testid="review-fraud-checks"
          >
            {submission.fraudChecks.map((check) => (
              <li key={check.check}>
                <Badge
                  variant={check.passed ? "outline" : "destructive"}
                  className="h-auto whitespace-normal py-0.5 text-left font-mono"
                >
                  {check.check}: {check.passed ? "passed" : "flagged"} —{" "}
                  {check.detail}
                </Badge>
              </li>
            ))}
          </ul>
          <ReviewActions
            campaignId={target.campaignId}
            submissionId={submission.id}
          />
        </CardContent>
      </Card>
    </li>
  );
}

export default async function ReviewQueuePage({ params }: PageProps) {
  const { id: campaignId } = await params;
  const session = await auth();

  if (
    !session ||
    (session.principalType !== "site_admin" &&
      session.principalType !== "host") ||
    !session.userId
  ) {
    return (
      <DeniedMessage message="A staff (host/site-admin) session is required." />
    );
  }

  const principal = await resolveStaffPrincipal(session.userId);
  if (!principal) {
    return <DeniedMessage message="This staff account no longer exists." />;
  }

  let items: ReviewQueueItem[];
  try {
    items = await listReviewQueue(principal, campaignId);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return (
        <DeniedMessage message="You are not authorized to review this campaign." />
      );
    }
    throw err;
  }

  return (
    <PageShell
      title="Review queue"
      description="Screen geotagged flier submissions before they pay out."
    >
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing needs review right now.
        </p>
      ) : (
        <ul className="flex flex-col gap-4" data-testid="review-queue-list">
          {items.map((item) => (
            <ReviewCard key={item.submission.id} item={item} />
          ))}
        </ul>
      )}
    </PageShell>
  );
}
