import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  createFamilyInvite,
  fetchFamily,
  removeFamilyMember,
  renameFamily,
  revokeFamilyInvite,
  setFamilyMemberRole,
  type CreatedInvite,
  type FamilyMember,
  type FamilyOverview,
  type FamilyRole,
} from "../api";
import { useAuth } from "../auth";
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  RoleBadge,
  Select,
  Skeleton,
  Toast,
} from "../ui";
import { dateLabel } from "./bills-shared";

const roleOptions = [
  { value: "member", label: "สมาชิก" },
  { value: "owner", label: "เจ้าของหอ" },
];

function roleOf(value: string): FamilyRole {
  return value === "owner" ? "owner" : "member";
}

function InviteLinkPanel({
  invite,
  onDismiss,
}: {
  invite: CreatedInvite;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = () => {
    setCopyFailed(false);

    void navigator.clipboard
      .writeText(invite.url)
      .then(() => {
        setCopied(true);
      })
      .catch(() => {
        setCopied(false);
        setCopyFailed(true);
      });
  };

  return (
    <div className="mt-3 grid gap-3 rounded-lg border border-ash bg-paper-mist px-3 py-3">
      <div>
        <p className="text-sm text-charcoal">{`ลิงก์คำเชิญสำหรับ ${invite.email}`}</p>
        <p className="mt-1 text-xs text-steel">
          ลิงก์นี้แสดงเพียงครั้งเดียว ระบบเก็บไว้เฉพาะค่าแฮช จึงเปิดดูซ้ำไม่ได้
          ถ้าลิงก์หายต้องออกคำเชิญใหม่
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          readOnly
          aria-label="ลิงก์คำเชิญ"
          className="input num min-w-0 flex-1 text-xs"
          value={invite.url}
          onFocus={(event) => {
            event.target.select();
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          icon={copied ? "check" : "content_copy"}
          onClick={copy}
        >
          {copied ? "คัดลอกแล้ว" : "คัดลอกลิงก์"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          ซ่อน
        </Button>
      </div>
      <p className="num text-xs text-fog">{`หมดอายุ ${dateLabel(invite.expiresAt)}`}</p>
      {copyFailed && (
        <p className="text-xs text-danger" role="alert">
          คัดลอกอัตโนมัติไม่สำเร็จ กรุณาเลือกข้อความแล้วคัดลอกเอง
        </p>
      )}
    </div>
  );
}

export function FamilyPage() {
  const { user } = useAuth();
  const [overview, setOverview] = useState<FamilyOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<FamilyRole>("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<ApiError | null>(null);
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);

  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<FamilyMember | null>(
    null,
  );

  const isOwner = user !== null && user.role === "owner";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const next = await fetchFamily();
      setOverview(next);
      setName(next.family.name);
    } catch (loadError) {
      setError(
        loadError instanceof ApiError
          ? loadError.message
          : "โหลดข้อมูลครอบครัวไม่สำเร็จ",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (toast === null) {
      return;
    }

    const timer = window.setTimeout(() => {
      setToast(null);
    }, 3000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [toast]);

  const saveName = (event: FormEvent) => {
    event.preventDefault();

    if (savingName || overview === null) {
      return;
    }

    const trimmed = name.trim();

    if (trimmed === "" || trimmed === overview.family.name) {
      return;
    }

    setSavingName(true);
    setNameError(null);

    void renameFamily(trimmed)
      .then((family) => {
        setOverview((current) =>
          current === null ? current : { ...current, family },
        );
        setName(family.name);
        setToast("บันทึกชื่อครอบครัวแล้ว");
      })
      .catch((failure: unknown) => {
        setNameError(
          failure instanceof ApiError
            ? failure.message
            : "บันทึกชื่อครอบครัวไม่สำเร็จ",
        );
      })
      .finally(() => {
        setSavingName(false);
      });
  };

  const submitInvite = (event: FormEvent) => {
    event.preventDefault();

    if (inviting) {
      return;
    }

    setInviting(true);
    setInviteError(null);

    void createFamilyInvite(inviteEmail.trim(), inviteRole)
      .then((invite) => {
        setCreatedInvite(invite);
        setInviteEmail("");
        setToast(`ออกคำเชิญให้ ${invite.email} แล้ว`);
        void load();
      })
      .catch((failure: unknown) => {
        setInviteError(
          failure instanceof ApiError
            ? failure
            : new ApiError("ออกคำเชิญไม่สำเร็จ", "UNKNOWN"),
        );
      })
      .finally(() => {
        setInviting(false);
      });
  };

  const revoke = (id: string) => {
    if (busyInviteId !== null) {
      return;
    }

    setBusyInviteId(id);

    void revokeFamilyInvite(id)
      .then(() => {
        setToast("ยกเลิกคำเชิญแล้ว");
        void load();
      })
      .catch((failure: unknown) => {
        setToast(
          failure instanceof ApiError
            ? failure.message
            : "ยกเลิกคำเชิญไม่สำเร็จ",
        );
      })
      .finally(() => {
        setBusyInviteId(null);
      });
  };

  const changeRole = (member: FamilyMember, next: FamilyRole) => {
    if (busyMemberId !== null || member.role === next) {
      return;
    }

    setBusyMemberId(member.userId);

    void setFamilyMemberRole(member.userId, next)
      .then(() => {
        setToast(
          next === "owner"
            ? `ตั้ง ${member.displayName} เป็นเจ้าของหอแล้ว`
            : `ลด ${member.displayName} เป็นสมาชิกแล้ว`,
        );
        void load();
      })
      .catch((failure: unknown) => {
        setToast(
          failure instanceof ApiError
            ? failure.message
            : "เปลี่ยนสิทธิ์ไม่สำเร็จ",
        );
        void load();
      })
      .finally(() => {
        setBusyMemberId(null);
      });
  };

  const confirmRemove = () => {
    if (memberToRemove === null || busyMemberId !== null) {
      return;
    }

    const target = memberToRemove;
    setBusyMemberId(target.userId);

    void removeFamilyMember(target.userId)
      .then(() => {
        setToast(`นำ ${target.displayName} ออกจากครอบครัวแล้ว`);
        setMemberToRemove(null);
        void load();
      })
      .catch((failure: unknown) => {
        setToast(
          failure instanceof ApiError
            ? failure.message
            : "นำสมาชิกออกไม่สำเร็จ",
        );
        setMemberToRemove(null);
      })
      .finally(() => {
        setBusyMemberId(null);
      });
  };

  const members = overview?.members ?? [];
  const invites = overview?.invites ?? [];
  const maxMembers = overview?.maxMembers ?? 0;
  const familyFull = maxMembers > 0 && members.length >= maxMembers;
  const nameChanged =
    overview !== null &&
    name.trim() !== "" &&
    name.trim() !== overview.family.name;

  return (
    <div>
      <PageHeader
        title="ครอบครัว"
        supporting="สมาชิกและคำเชิญของหอนี้ ข้อมูลหอแยกจากครอบครัวอื่นโดยสมบูรณ์"
      />

      {error !== null ? (
        <Card>
          <EmptyState
            icon="cloud_off"
            title="โหลดข้อมูลครอบครัวไม่สำเร็จ"
            description={error}
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
        </Card>
      ) : loading && overview === null ? (
        <Card>
          <div className="grid gap-4" aria-busy="true">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 [&>*]:min-w-0">
          {/* min-w-0: อีเมล/ชื่อที่สั่ง truncate ไว้มี min-content เท่าความยาวเต็ม ถ้าไม่ปล่อย
              ให้การ์ดแคบกว่านั้น แถวจะดันกริดจนล้นจอ 390px (วัดจริง 404px) */}
          <Card>
            <CardHeader
              title="ข้อมูลครอบครัว"
              description={
                isOwner
                  ? "ชื่อนี้ใช้เรียกหอในหน้าจอของผู้ใช้ทุกคน"
                  : "แก้ไขได้เฉพาะเจ้าของหอ"
              }
            />
            {isOwner ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={saveName}
                noValidate
              >
                <div className="min-w-[220px] flex-1">
                  <Field
                    label="ชื่อครอบครัว"
                    value={name}
                    onChange={setName}
                    error={nameError ?? undefined}
                  />
                </div>
                <Button
                  variant="primary"
                  type="submit"
                  icon="save"
                  disabled={savingName || !nameChanged}
                >
                  {savingName ? "กำลังบันทึก" : "บันทึกชื่อ"}
                </Button>
              </form>
            ) : (
              <p className="text-sm text-charcoal">
                {overview?.family.name ?? ""}
              </p>
            )}
          </Card>

          <Card>
            <CardHeader
              title="สมาชิก"
              description="ทุกคนในครอบครัวเห็นห้อง ผู้เช่า และบิลชุดเดียวกัน"
            />
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
              {members.map((member) => {
                const isSelf = user !== null && member.userId === user.id;
                const busy = busyMemberId === member.userId;

                return (
                  <li
                    key={member.userId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ash px-3 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-paper-mist text-[0.8125rem] font-semibold text-charcoal">
                        {member.displayName.slice(0, 1)}
                      </span>
                      <div className="min-w-0">
                        <span className="block truncate text-sm text-charcoal">
                          {member.displayName}
                          {isSelf && (
                            <span className="ms-1.5 text-[0.6875rem] text-fog">
                              (คุณ)
                            </span>
                          )}
                        </span>
                        <span
                          className="num block truncate text-xs text-fog"
                          title={`${member.email} · เข้าร่วม ${dateLabel(member.joinedAt)}`}
                        >
                          {`${member.email} · เข้าร่วม ${dateLabel(member.joinedAt)}`}
                        </span>
                      </div>
                    </div>

                    {isOwner && !isSelf ? (
                      <div className="flex items-center gap-2">
                        <div className="w-[132px]">
                          <Select
                            label="สิทธิ์"
                            value={member.role}
                            options={roleOptions}
                            onChange={(value) => {
                              changeRole(member, roleOf(value));
                            }}
                          />
                        </div>
                        <IconButton
                          icon="person_remove"
                          label={`นำ ${member.displayName} ออก`}
                          disabled={busy}
                          onClick={() => {
                            setMemberToRemove(member);
                          }}
                        />
                      </div>
                    ) : (
                      <RoleBadge role={member.role} />
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>

          {isOwner && (
            <Card>
              <CardHeader
                title="คำเชิญ"
                description={
                  familyFull
                    ? `ครอบครัวนี้มีสมาชิกครบ ${maxMembers} คนแล้ว ต้องนำคนเดิมออกก่อนจึงจะเชิญคนใหม่ได้`
                    : "คำเชิญอายุ 7 วัน และใช้ได้ครั้งเดียว"
                }
              />

              {!familyFull && (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={submitInvite}
                  noValidate
                >
                  <div className="min-w-[220px] flex-1">
                    <Field
                      label="อีเมลผู้รับคำเชิญ"
                      type="email"
                      value={inviteEmail}
                      onChange={setInviteEmail}
                      placeholder="member@example.com"
                      error={
                        inviteError !== null && inviteError.field === "email"
                          ? inviteError.message
                          : undefined
                      }
                    />
                  </div>
                  <div className="w-[132px]">
                    <Select
                      label="สิทธิ์"
                      value={inviteRole}
                      options={roleOptions}
                      onChange={(value) => {
                        setInviteRole(roleOf(value));
                      }}
                    />
                  </div>
                  <Button
                    variant="secondary"
                    type="submit"
                    icon="person_add"
                    disabled={inviting || inviteEmail.trim() === ""}
                  >
                    {inviting ? "กำลังออกคำเชิญ" : "ออกคำเชิญ"}
                  </Button>
                </form>
              )}

              {inviteError !== null && inviteError.field === undefined && (
                <p className="mt-2 text-xs text-danger" role="alert">
                  {inviteError.message}
                </p>
              )}

              {createdInvite !== null && (
                <InviteLinkPanel
                  invite={createdInvite}
                  onDismiss={() => {
                    setCreatedInvite(null);
                  }}
                />
              )}

              {invites.length === 0 ? (
                <p className="mt-3 text-sm text-fog">ยังไม่มีคำเชิญที่ค้างอยู่</p>
              ) : (
                <ul className="mt-3 grid gap-2">
                  {invites.map((invite) => (
                    <li
                      key={invite.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ash px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <span className="num block truncate text-sm text-charcoal">
                          {invite.email}
                        </span>
                        <span className="block text-xs text-fog">{`${roleOptions.find((option) => option.value === invite.role)?.label ?? "สมาชิก"} · หมดอายุ ${dateLabel(invite.expiresAt)}`}</span>
                      </div>
                      <Button
                        variant="danger-soft"
                        size="sm"
                        icon="cancel"
                        disabled={busyInviteId === invite.id}
                        onClick={() => {
                          revoke(invite.id);
                        }}
                      >
                        {busyInviteId === invite.id ? "กำลังยกเลิก" : "ยกเลิกคำเชิญ"}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      )}

      <Dialog
        open={memberToRemove !== null}
        onClose={() => {
          setMemberToRemove(null);
        }}
        title="นำสมาชิกออกจากครอบครัว"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setMemberToRemove(null);
              }}
            >
              ยกเลิก
            </Button>
            <Button
              variant="danger-soft"
              icon="person_remove"
              disabled={busyMemberId !== null}
              onClick={confirmRemove}
            >
              {busyMemberId !== null ? "กำลังนำออก" : "นำออกจากครอบครัว"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-steel">
          {memberToRemove === null
            ? ""
            : `${memberToRemove.displayName} จะเข้าใช้งานหอนี้ไม่ได้อีก แต่ข้อมูลห้อง ผู้เช่า และบิลยังอยู่ครบ ต้องมีคำเชิญใหม่จึงจะกลับเข้ามาได้`}
        </p>
      </Dialog>

      <Toast message={toast ?? ""} open={toast !== null} />
    </div>
  );
}
