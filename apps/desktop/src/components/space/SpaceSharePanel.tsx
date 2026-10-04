import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { api } from "../../lib/api";
import { Badge, Button } from "../ui";

/**
 * FR-TC-05/06 share panel: member list with perm editing (manager only),
 * invite link creation with the one-time token shown as text + QR, and token
 * redemption for the invitee side. The server is the only permission judge —
 * this surface mirrors its verdicts.
 */

type Member = {
  userId: string;
  username: string;
  displayName: string | null;
  perm: string;
  createdAt: string;
};

const PERMS = ["viewer", "contributor", "manager"] as const;

export function SpaceSharePanel(props: {
  spaceId: string;
  myPerm: string;
  onClose: () => void;
}) {
  const { spaceId, myPerm, onClose } = props;
  const { t } = useTranslation();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invite, setInvite] = useState<{ token: string; perm: string; expiresAt: string | null } | null>(null);
  const [redeemToken, setRedeemToken] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setMembers((await api.spaceMembersList({ spaceId })) ?? []);
    } catch {
      setMembers([]);
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const createInvite = async () => {
    setBusy(true);
    try {
      const created = await api.spaceInviteCreate({ spaceId, perm: "viewer", expiresInDays: 7 });
      setInvite(created);
      setQrDataUrl(
        await QRCode.toDataURL(`laboflow://space/invite?token=${created.token}`, {
          margin: 1,
          width: 160,
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const redeem = async () => {
    setBusy(true);
    try {
      const result = await api.spaceInviteRedeem({ token: redeemToken.trim() });
      setRedeemToken("");
      onClose();
      // Reopening the space list picks up the joined space.
      window.setTimeout(() => window.location.reload(), 600);
      return result;
    } finally {
      setBusy(false);
    }
  };

  const isManager = myPerm === "manager";

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="space-share-panel">
      <div className="flex items-center justify-between">
        <span className="font-medium">{t("space.share.title")}</span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>

      <ul className="flex flex-col gap-1">
        {(members ?? []).map((member) => (
          <li key={member.userId} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">
              {member.displayName || member.username}
            </span>
            <Badge tone="neutral">{t(`space.share.perm.${member.perm}`)}</Badge>
            {isManager ? (
              <>
                <select
                  className="rounded border px-1 py-0.5 text-xs"
                  value={member.perm}
                  disabled={busy}
                  onChange={(event) =>
                    void run(() =>
                      api.spaceMembersUpdate({
                        spaceId,
                        userId: member.userId,
                        perm: event.target.value,
                      }),
                    )
                  }
                >
                  {PERMS.map((perm) => (
                    <option key={perm} value={perm}>
                      {t(`space.share.perm.${perm}`)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="text-xs opacity-60 hover:opacity-100"
                  disabled={busy}
                  onClick={() => void run(() => api.spaceMembersRemove({ spaceId, userId: member.userId }))}
                >
                  {t("space.share.remove")}
                </button>
              </>
            ) : null}
          </li>
        ))}
        {!members ? <li className="opacity-60">{t("space.share.loading")}</li> : null}
      </ul>

      {isManager ? (
        <div className="flex flex-col gap-2 rounded-md border p-3" style={{ borderColor: "var(--ds-border)" }}>
          <span className="text-xs font-medium">{t("space.share.inviteTitle")}</span>
          {!invite ? (
            <Button size="sm" disabled={busy} onClick={() => void createInvite()}>
              {t("space.share.createInvite")}
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <code className="break-all rounded bg-black/5 px-2 py-1 text-xs" data-testid="space-invite-token">
                {invite.token}
              </code>
              {qrDataUrl ? <img src={qrDataUrl} alt={t("space.share.qrAlt")} width={160} height={160} /> : null}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void navigator.clipboard.writeText(`laboflow://space/invite?token=${invite.token}`)
                  }
                >
                  {t("space.share.copy")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setInvite(null)}>
                  {t("space.share.inviteAnother")}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 rounded-md border p-3" style={{ borderColor: "var(--ds-border)" }}>
        <span className="text-xs font-medium">{t("space.share.redeemTitle")}</span>
        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded border px-2 py-1 text-xs"
            style={{ borderColor: "var(--ds-border)" }}
            placeholder={t("space.share.redeemPlaceholder")}
            value={redeemToken}
            onChange={(event) => setRedeemToken(event.target.value)}
          />
          <Button
            size="sm"
            disabled={busy || !redeemToken.trim()}
            onClick={() => void redeem()}
          >
            {t("space.share.redeem")}
          </Button>
        </div>
      </div>
    </div>
  );
}
