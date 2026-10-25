import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchPendingLinks, linkPendingUser, type PendingLink } from "../api";
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Select, Skeleton } from "../ui";
import type { Tenant } from "../mock-data";

export interface PendingLineUser {
  id: string;
  displayName: string;
  lastMessage: string;
  time: string;
}

export interface PairingResult {
  pendingId: string;
  tenantId: string;
  tenantName: string;
  roomId: string;
}

function formatLastSeen(value: string): string {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  const day = String(parsed.getDate()).padStart(2, "0");
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");

  return `${day}/${month} ${hours}:${minutes}`;
}

function toPendingUser(link: PendingLink): PendingLineUser {
  const displayName = link.displayName.trim();

  return {
    id: link.lineUserId,
    displayName: displayName === "" ? "ผู้ใช้ LINE" : displayName,
    lastMessage: link.lastMessage === null || link.lastMessage === "" ? "ยังไม่ได้พิมพ์ข้อความ" : link.lastMessage,
    time: formatLastSeen(link.lastSeenAt),
  };
}

export interface PairingSurfaceProps {
  tenants: Tenant[];
  onPaired: (result: PairingResult) => void;
  onBack: () => void;
}

export function PairingSurface({ tenants, onPaired, onBack }: PairingSurfaceProps) {
  const [pending, setPending] = useState<PendingLineUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [selectedPendingId, setSelectedPendingId] = useState("");
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const [success, setSuccess] = useState<PairingResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    try {
      const links = await fetchPendingLinks();
      setPending(links.map(toPendingUser));
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.message : "โหลดรายการรอเชื่อม LINE ไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activePending = pending.find((user) => user.id === selectedPendingId) ?? pending[0] ?? null;
  const candidates = tenants.filter((tenant) => tenant.status === "current" && !tenant.lineLinked);

  const pair = async () => {
    const tenant = candidates.find((item) => item.id === selectedTenantId);

    if (activePending === null || tenant === undefined || pairing) {
      return;
    }

    setPairing(true);
    setPairError(null);

    try {
      await linkPendingUser(activePending.id, tenant.id);

      const result: PairingResult = {
        pendingId: activePending.id,
        tenantId: tenant.id,
        tenantName: tenant.name,
        roomId: tenant.roomId,
      };

      onPaired(result);
      await load();
      setSuccess(result);
      setSelectedTenantId("");
    } catch (error) {
      setPairError(error instanceof ApiError ? error.message : "จับคู่ LINE ไม่สำเร็จ");
    } finally {
      setPairing(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="จัดการการเชื่อม LINE"
        supporting={
          loading
            ? "กำลังโหลดรายการรอเชื่อม LINE"
            : pending.length === 0
              ? "ไม่มีผู้ใช้ LINE รอจับคู่"
              : `${pending.length} คนที่แอด LINE แล้วแต่ยังจับคู่ไม่ได้`
        }
        actions={
          <Button variant="ghost" icon="arrow_back" onClick={onBack}>
            กลับไปรายชื่อผู้เช่า
          </Button>
        }
      />

      {success === null ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Card className="lg:max-h-[calc(100vh-9rem)] lg:overflow-y-auto">
            <CardHeader title="ผู้ใช้ LINE รอจับคู่" description={loading ? "กำลังโหลด" : `แสดง ${pending.length} คน`} />
            {loading ? (
              <div className="grid gap-3" aria-busy="true">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-2/3" />
              </div>
            ) : loadError !== null ? (
              <EmptyState
                icon="cloud_off"
                title="โหลดรายการรอเชื่อมไม่สำเร็จ"
                description={loadError}
                action={
                  <Button
                    variant="secondary"
                    icon="refresh"
                    onClick={() => {
                      void load();
                    }}
                  >
                    ลองใหม่
                  </Button>
                }
              />
            ) : pending.length === 0 ? (
              <p className="py-6 text-center text-sm text-fog">ไม่มีผู้ใช้ LINE รอจับคู่ในขณะนี้</p>
            ) : (
              <ul className="grid gap-2">
                {pending.map((user) => {
                  const active = activePending !== null && user.id === activePending.id;

                  return (
                    <li key={user.id}>
                      <button
                        type="button"
                        aria-pressed={active}
                        onClick={() => {
                          setSelectedPendingId(user.id);
                        }}
                        className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                          active ? "border-pebble bg-paper-mist" : "border-ash hover:bg-paper-mist"
                        }`}
                      >
                        <span
                          className="ms grid h-10 w-10 shrink-0 place-items-center rounded-full bg-paper-mist text-[1.25rem] text-slate"
                          aria-hidden="true"
                        >
                          person
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium text-charcoal">{user.displayName}</span>
                            <span className="shrink-0 text-[0.6875rem] text-fog">{user.time}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-fog">{user.lastMessage}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            {loading ? (
              <div className="grid gap-4" aria-busy="true">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : activePending === null ? (
              <EmptyState
                icon="link"
                title="ยังไม่มีผู้ใช้ LINE รอจับคู่"
                description="เมื่อผู้เช่าแอดบอทและพิมพ์เลขห้อง ระบบจะแสดงรายชื่อไว้ที่นี่เพื่อจับคู่กับผู้เช่า"
                action={
                  <Button variant="secondary" icon="arrow_back" onClick={onBack}>
                    กลับไปรายชื่อผู้เช่า
                  </Button>
                }
              />
            ) : (
              <div className="grid gap-4">
                <CardHeader
                  title="จับคู่กับผู้เช่า"
                  description="เลือกผู้เช่าที่ตรงกับผู้ใช้ LINE รายนี้"
                  actions={<Badge tone="neutral">รอจับคู่</Badge>}
                />

                <div className="panel-muted">
                  <p className="text-sm text-charcoal">{activePending.displayName}</p>
                  <p className="mt-1 text-sm text-steel">{activePending.lastMessage}</p>
                  <p className="mt-1 text-xs text-fog">ข้อความล่าสุด · {activePending.time}</p>
                </div>

                {candidates.length === 0 ? (
                  <p className="text-sm text-fog">ผู้เช่าทุกคนเชื่อม LINE แล้ว จึงไม่มีรายการให้จับคู่เพิ่ม</p>
                ) : (
                  <>
                    <Select
                      label="เลือกผู้เช่า"
                      value={selectedTenantId}
                      onChange={(value) => {
                        setSelectedTenantId(value);
                        setPairError(null);
                      }}
                      options={[
                        { value: "", label: "ยังไม่ได้เลือก" },
                        ...candidates.map((tenant) => ({
                          value: tenant.id,
                          label: `${tenant.name} · ห้อง ${tenant.roomId}`,
                        })),
                      ]}
                      helper="จับคู่แล้วบิลและข้อความยืนยันจะส่งถึงผู้ใช้ LINE รายนี้"
                    />

                    <div className="grid gap-2">
                      {pairError !== null && <p className="text-xs text-danger">{pairError}</p>}
                      <div className="flex justify-end">
                        <Button
                          variant="primary"
                          icon="link"
                          disabled={selectedTenantId === "" || pairing}
                          onClick={() => {
                            void pair();
                          }}
                        >
                          จับคู่ LINE
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </Card>
        </div>
      ) : (
        <Card>
          <EmptyState
            icon="link"
            title={`เชื่อม LINE กับ คุณ${success.tenantName} ห้อง ${success.roomId} สำเร็จ`}
            description="ผู้เช่าจะได้รับข้อความยืนยันใน LINE และบิลของห้องนี้จะส่งถึงผู้ใช้ LINE รายนี้ได้แล้ว"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {pending.length > 0 && (
                  <Button
                    variant="secondary"
                    icon="link"
                    onClick={() => {
                      setSuccess(null);
                    }}
                  >
                    จับคู่รายการถัดไป
                  </Button>
                )}
                <Button variant="primary" icon="arrow_back" onClick={onBack}>
                  กลับไปรายชื่อผู้เช่า
                </Button>
              </div>
            }
          />
        </Card>
      )}
    </div>
  );
}
