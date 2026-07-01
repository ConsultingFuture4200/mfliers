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
import { ReviewActions } from "./ReviewActions";

interface PageParams {
  id: string;
}

interface PageProps {
  params: Promise<PageParams>;
}

function DeniedMessage({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <p className="text-sm text-destructive" data-testid="review-denied">
        {message}
      </p>
    </main>
  );
}

function ReviewCard({ item }: { item: ReviewQueueItem }) {
  const { submission, target, distanceM, player, photoUrl } = item;
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border border-input p-4"
      data-testid="review-card"
      data-submission-id={submission.id}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- signed R2
          URLs are short-lived and per-request; next/image's remote-pattern
          allowlist doesn't fit a presigned, unique-per-view URL. */}
      <img
        src={photoUrl}
        alt={`Submission photo for target ${target.label}`}
        className="max-h-64 w-full rounded-md object-cover"
      />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Target</dt>
        <dd data-testid="review-target">{target.label}</dd>
        <dt className="text-muted-foreground">Distance from target</dt>
        <dd data-testid="review-distance">
          {distanceM !== null ? `${distanceM.toFixed(1)} m` : "unknown"}
        </dd>
        <dt className="text-muted-foreground">Canvasser</dt>
        <dd data-testid="review-canvasser">{player?.phone ?? "unknown"}</dd>
        <dt className="text-muted-foreground">Received</dt>
        <dd>{submission.receivedAt.toISOString()}</dd>
      </dl>
      <ul
        className="flex flex-col gap-1 text-sm"
        data-testid="review-fraud-checks"
      >
        {submission.fraudChecks.map((check) => (
          <li
            key={check.check}
            className={check.passed ? "text-foreground" : "text-destructive"}
          >
            {check.check}: {check.passed ? "passed" : "flagged"} —{" "}
            {check.detail}
          </li>
        ))}
      </ul>
      <ReviewActions
        campaignId={target.campaignId}
        submissionId={submission.id}
      />
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
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-lg font-semibold">Review queue</h1>
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
    </main>
  );
}
