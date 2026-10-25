import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  billsChangedEvent,
  billsFocusHash,
  fetchBillPeriods,
  fetchBills,
  fetchSettings,
  fetchTenants,
  sendBill,
  sendBills,
  type Bill,
  type SendAllResult,
  type Settings,
  type Tenant,
} from "../api";
import { useSearch } from "../search";
import {
  Button,
  Card,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  HeroMoney,
  IconButton,
  PageHeader,
  Skeleton,
  StatusBadge,
  Toast,
  type DataTableColumn,
  type PageProps,
} from "../ui";
import {
  LineStateBadge,
  baht,
  chargesTotal,
} from "./bills-shared";
import { periodLabel, periodOptions } from "../period";
import {
  BillEditDrawer,
  DeleteBillDialog,
  MarkPaidDialog,
} from "./bills-actions";
import { BillDetail } from "./bills-detail";
import { BillSlipDialog } from "./bills-slip-dialog";
import { ExportBillsDialog } from "./bills-export";
import { CreateWizard } from "./bills-create";
import { electricUnitsOf } from "../../shared/billing";

const statusOptions = [
  { value: "all", label: "ทั้งหมด" },
  { value: "unpaid", label: "ยังไม่จ่าย" },
  { value: "paid", label: "จ่ายแล้ว" },
] as const;

function Money({ value }: { value: number }) {
  return <span className="num whitespace-nowrap">{`${baht(value)} บาท`}</span>;
}

function MeterReading({
  previous,
  current,
  units,
  withUnit = false,
}: {
  previous: number;
  current: number;
  units: number;
  withUnit?: boolean;
}) {
  return (
    <span className="num whitespace-nowrap">
      <span className="text-charcoal">{`${previous} → ${current}`}</span>
      <span className="text-fog">
        {withUnit ? ` · ${units} หน่วย` : ` · ${units}`}
      </span>
    </span>
  );
}

interface BillsRouteTarget {
  roomNumber: string;
  period: string;
  billId: string | null;
}

function hashParts(hash: string): string[] {
  const [pathPart = ""] = hash.replace(/^#/, "").split("?");
  return pathPart.split("/");
}

function hashParams(hash: string): URLSearchParams {
  const [, searchPart = ""] = hash.replace(/^#/, "").split("?");
  return new URLSearchParams(searchPart);
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function billsTargetOf(hash: string): BillsRouteTarget {
  const parts = hashParts(hash);
  const params = hashParams(hash);
  const isBills = parts[0] === "bills";
  const billIdPart = parts[2] ?? "";

  return {
    roomNumber: isBills ? (params.get("room") ?? "") : "",
    period: isBills ? (params.get("period") ?? "") : "",
    billId:
      isBills && parts[1] === "detail" && billIdPart !== ""
        ? decodeSegment(billIdPart)
        : null,
  };
}

function listHash(roomNumber: string, period: string): string {
  if (roomNumber !== "") {
    return billsFocusHash({ roomNumber, period });
  }

  return period === ""
    ? "#bills"
    : `#bills?period=${encodeURIComponent(period)}`;
}

function detailHash(
  billId: string,
  period: string,
  roomNumber: string,
): string {
  const params = new URLSearchParams();

  if (period !== "") {
    params.set("period", period);
  }

  if (roomNumber !== "") {
    params.set("room", roomNumber);
  }

  const query = params.toString();
  return `#bills/detail/${encodeURIComponent(billId)}${query === "" ? "" : `?${query}`}`;
}

interface BillListProps {
  bills: Bill[];
  loading: boolean;
  error: string | null;
  period: string;
  periods: string[];
  connectedIds: Set<string> | null;
  statusFilter: string;
  roomFilter: string;
  onPeriodChange: (period: string) => void;
  onStatusFilterChange: (value: string) => void;
  onClearRoom: () => void;
  onOpen: (bill: Bill) => void;
  onManage: (bill: Bill) => void;
  onSend: (bill: Bill) => void;
  onSendAll: () => void;
  onRetryFailed: () => void;
  onDismissResult: () => void;
  sendingId: string | null;
  bulkSending: boolean;
  sendResult: SendAllResult | null;
  onCreate: () => void;
  onExport: () => void;
  onRetry: () => void;
}

function sendResultLabel(result: SendAllResult): string {
  if (result.sent > 0) {
    return `ส่งบิลทาง LINE แล้ว ${result.sent} ใบ`;
  }

  if (result.failed > 0) {
    return `ส่งบิลทาง LINE ไม่สำเร็จ ${result.failed} ใบ`;
  }

  return "ไม่มีบิลที่ส่งได้ในเดือนนี้";
}

function BillList({
  bills,
  loading,
  error,
  period,
  periods,
  connectedIds,
  statusFilter,
  roomFilter,
  onPeriodChange,
  onStatusFilterChange,
  onClearRoom,
  onOpen,
  onManage,
  onSend,
  onSendAll,
  onRetryFailed,
  onDismissResult,
  sendingId,
  bulkSending,
  sendResult,
  onCreate,
  onExport,
  onRetry,
}: BillListProps) {
  const { query, setQuery } = useSearch();
  const [slipBill, setSlipBill] = useState<Bill | null>(null);
  const connectedOf = (bill: Bill): boolean | null =>
    connectedIds === null ? null : connectedIds.has(bill.tenantId);
  const sendReason = (bill: Bill): string | undefined => {
    const connected = connectedOf(bill);
    return connected === true
      ? undefined
      : connected === false
        ? "ผู้เช่ายังไม่เชื่อม LINE"
        : "ยังไม่ทราบสถานะ LINE ของผู้เช่า";
  };
  const scoped =
    roomFilter === ""
      ? bills
      : bills.filter((bill) => bill.roomNumber === roomFilter);
  const paidCount = scoped.filter((bill) => bill.status === "paid").length;
  const unpaidCount = scoped.length - paidCount;
  const monthTotal = scoped.reduce((sum, bill) => sum + bill.total, 0);

  const needle = query.trim().toLowerCase();
  const filtered = scoped.filter((bill) => {
    const matchesQuery =
      needle === "" ||
      bill.roomNumber.toLowerCase().includes(needle) ||
      bill.tenantName.toLowerCase().includes(needle);
    const matchesStatus =
      statusFilter === "all" || bill.status === statusFilter;
    return matchesQuery && matchesStatus;
  });

  const columns: DataTableColumn<Bill>[] = [
    {
      key: "room",
      header: "ห้อง / ผู้เช่า",
      render: (bill) => (
        <button
          type="button"
          className="text-left"
          onClick={() => onOpen(bill)}
        >
          <span className="block font-medium text-charcoal hover:underline">
            {bill.roomNumber}
          </span>
          <span className="block text-xs text-fog">{bill.tenantName}</span>
        </button>
      ),
    },
    {
      key: "rent",
      header: "ค่าห้อง",
      align: "right",
      render: (bill) => <Money value={bill.rent} />,
    },
    {
      key: "waterMeter",
      header: "มิเตอร์น้ำ (หน่วย)",
      align: "right",
      render: (bill) => (
        <MeterReading
          previous={bill.waterPrevious}
          current={bill.waterCurrent}
          units={bill.waterUnits}
        />
      ),
    },
    {
      key: "electricMeter",
      header: "มิเตอร์ไฟ (หน่วย)",
      align: "right",
      render: (bill) => (
        <MeterReading
          previous={bill.electricPrevious}
          current={bill.electricCurrent}
          units={electricUnitsOf(bill)}
        />
      ),
    },
    {
      key: "water",
      header: "ค่าน้ำ",
      align: "right",
      render: (bill) => <Money value={bill.waterAmount} />,
    },
    {
      key: "electric",
      header: "ค่าไฟ",
      align: "right",
      render: (bill) => (
        <span className="inline-flex flex-col items-end">
          <Money value={bill.electricAmount} />
          {bill.electricMode === "flat" && (
            <span className="chip mt-1">ไฟเหมา</span>
          )}
        </span>
      ),
    },
    {
      key: "extra",
      header: "ค่าใช้จ่ายเพิ่ม",
      align: "right",
      render: (bill) => {
        const extraTotal = chargesTotal(bill.charges);
        return extraTotal === 0 ? (
          <span className="text-fog">—</span>
        ) : (
          <Money value={extraTotal} />
        );
      },
    },
    {
      key: "total",
      header: "รวม",
      align: "right",
      render: (bill) => (
        <span className="font-medium">
          <Money value={bill.total} />
        </span>
      ),
    },
    {
      key: "status",
      header: "สถานะ",
      render: (bill) => <StatusBadge status={bill.status} />,
    },
    {
      key: "line",
      header: "LINE",
      render: (bill) => (
        <LineStateBadge sentAt={bill.sentAt} connected={connectedOf(bill)} />
      ),
    },
    {
      key: "action",
      header: "จัดการ",
      align: "right",
      render: (bill) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => onOpen(bill)}>
            ดูบิล
          </Button>
          {bill.status === "paid" && (
            <Button
              size="sm"
              variant="secondary"
              icon="receipt_long"
              onClick={() => setSlipBill(bill)}
            >
              ดูสลิป
            </Button>
          )}
          {bill.status === "unpaid" && (
            <Button
              size="sm"
              variant="secondary"
              icon="send"
              disabled={connectedOf(bill) === false || sendingId === bill.id}
              title={sendReason(bill)}
              onClick={() => onSend(bill)}
            >
              {sendingId === bill.id ? "กำลังส่ง" : "ส่ง LINE"}
            </Button>
          )}
          {bill.status === "unpaid" && (
            <Button
              size="sm"
              variant="ghost"
              icon="more_horiz"
              onClick={() => onManage(bill)}
            >
              จัดการ
            </Button>
          )}
        </div>
      ),
    },
  ];

  const scopeLabel =
    roomFilter === ""
      ? periodLabel(period)
      : `ห้อง ${roomFilter} · ${periodLabel(period)}`;
  const supporting = loading
    ? "กำลังโหลดข้อมูลบิล"
    : error !== null
      ? undefined
      : scopeLabel;

  return (
    <div>
      <PageHeader
        title="บิล"
        supporting={supporting}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="field-label mb-0" htmlFor="bills-period">
              รอบบิล
            </label>
            <select
              id="bills-period"
              className="input w-auto"
              value={period}
              onChange={(event) => {
                onPeriodChange(event.target.value);
              }}
            >
              {periods.map((option) => (
                <option key={option} value={option}>
                  {periodLabel(option)}
                </option>
              ))}
            </select>
            <Button variant="primary" icon="add" onClick={onCreate}>
              สร้างบิล
            </Button>
            <Button
              variant="secondary"
              icon="send"
              className="hidden sm:inline-flex"
              disabled={scoped.length === 0 || bulkSending}
              onClick={onSendAll}
            >
              ส่งบิลทาง LINE
            </Button>
            <Button
              variant="secondary"
              icon="send"
              className="px-3 sm:hidden"
              aria-label="ส่งบิลทาง LINE"
              disabled={scoped.length === 0 || bulkSending}
              onClick={onSendAll}
            />
            <Button
              variant="secondary"
              icon="download"
              className="hidden sm:inline-flex"
              onClick={onExport}
            >
              ส่งออก Excel
            </Button>
            <Button
              variant="secondary"
              icon="download"
              className="px-3 sm:hidden"
              aria-label="ส่งออก Excel"
              onClick={onExport}
            />
          </div>
        }
      />

      {loading ? (
        <Card>
          <div className="grid gap-3" aria-busy="true">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        </Card>
      ) : error !== null ? (
        <Card>
          <EmptyState
            icon="cloud_off"
            title="โหลดข้อมูลบิลไม่สำเร็จ"
            description={error}
            action={
              <Button variant="secondary" icon="refresh" onClick={onRetry}>
                ลองใหม่
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {scoped.length > 0 && (
            <Card className="mb-4">
              <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                <HeroMoney value={baht(monthTotal)} label="ยอดรวม ของเดือน" />
                <p className="text-sm text-steel">{`${scoped.length} ใบ · จ่ายแล้ว ${paidCount} · ค้าง ${unpaidCount}`}</p>
                <div
                  className="ml-auto flex gap-1 rounded-lg border border-ash p-1"
                  role="group"
                  aria-label="กรองสถานะบิล"
                >
                  {statusOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={statusFilter === option.value}
                      className={`btn ${statusFilter === option.value ? "bg-status-unpaid-bg font-medium text-deep-sapphire" : "text-steel"}`}
                      onClick={() => {
                        onStatusFilterChange(option.value);
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </Card>
          )}

          {roomFilter !== "" && (
            <Card className="mb-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="chip">{`กรองเฉพาะห้อง ${roomFilter}`}</span>
                <span className="text-xs text-fog">
                  กำลังดูบิลของห้องนี้เท่านั้น
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="filter_alt_off"
                  className="ml-auto"
                  onClick={onClearRoom}
                >
                  ดูบิลทั้งหอ
                </Button>
              </div>
            </Card>
          )}

          <Card className="mb-4 md:hidden">
            <Field
              label="ค้นหาห้องหรือผู้เช่า"
              value={query}
              onChange={setQuery}
              placeholder="เช่น A105 หรือ สมชาย"
            />
          </Card>

          {sendResult !== null && (
            <Card className="mb-4">
              <div className="flex items-start gap-3">
                {sendResult.sent > 0 ? (
                  <span
                    className="ms mt-0.5 text-[1.25rem] text-status-paid-fg"
                    aria-hidden="true"
                  >
                    task_alt
                  </span>
                ) : sendResult.failed > 0 ? (
                  <span
                    className="ms mt-0.5 text-[1.25rem] text-danger"
                    aria-hidden="true"
                  >
                    error
                  </span>
                ) : (
                  <span
                    className="ms mt-0.5 text-[1.25rem] text-steel"
                    aria-hidden="true"
                  >
                    schedule
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-charcoal">
                    {sendResultLabel(sendResult)}
                  </p>
                  {(sendResult.failed > 0 || sendResult.skipped.length > 0) && (
                    <p className="mt-1 text-xs text-fog">
                      {sendResult.failed > 0
                        ? `ส่งไม่สำเร็จ ${sendResult.failed} ใบ`
                        : ""}
                      {sendResult.failed > 0 && sendResult.skipped.length > 0
                        ? " · "
                        : ""}
                      {sendResult.skipped.length > 0
                        ? `ยังไม่เชื่อม LINE ${sendResult.skipped.length} ห้อง`
                        : ""}
                    </p>
                  )}
                  {sendResult.skipped.length > 0 && (
                    <p className="mt-1 text-xs text-steel">
                      {sendResult.skipped
                        .map((item) => `${item.roomNumber} ${item.tenantName}`)
                        .join(" · ")}
                    </p>
                  )}
                  {sendResult.failedIds.length > 0 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="refresh"
                      className="mt-2"
                      disabled={bulkSending}
                      onClick={onRetryFailed}
                    >
                      ส่งซ้ำเฉพาะที่ล้มเหลว
                    </Button>
                  )}
                </div>
                <IconButton
                  icon="close"
                  label="ปิดผลการส่งบิล"
                  onClick={onDismissResult}
                />
              </div>
            </Card>
          )}

          {scoped.length === 0 ? (
            <Card>
              {roomFilter === "" ? (
                <EmptyState
                  icon="receipt_long"
                  title="ยังไม่มีบิลเดือนนี้"
                  description="เริ่มสร้างบิลทั้งหอจากการกรอกเลขมิเตอร์ของทุกห้องในครั้งเดียว"
                  action={
                    <Button variant="primary" icon="add" onClick={onCreate}>
                      สร้างบิลเดือนนี้
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon="receipt_long"
                  title={`ห้อง ${roomFilter} ยังไม่มีบิลในรอบนี้`}
                  description="ลองเปลี่ยนรอบบิลด้านบน หรือกลับไปดูบิลทั้งหอ"
                  action={
                    <Button
                      variant="secondary"
                      icon="filter_alt_off"
                      onClick={onClearRoom}
                    >
                      ดูบิลทั้งหอ
                    </Button>
                  }
                />
              )}
            </Card>
          ) : (
            <>
              <Card className="hidden min-[1120px]:block">
                <DataTable
                  columns={columns}
                  rows={filtered}
                  getRowKey={(bill) => bill.id}
                  minWidth={1120}
                  stickyHeader
                  emptyMessage="ไม่พบบิลที่ตรงกับเงื่อนไข"
                />
              </Card>

              <div className="grid gap-3 min-[1120px]:hidden">
                {filtered.length === 0 && (
                  <Card>
                    <EmptyState
                      icon="receipt_long"
                      title="ไม่พบบิลที่ตรงกับเงื่อนไข"
                      description="ลองล้างคำค้นหาหรือเปลี่ยนตัวกรองสถานะ"
                    />
                  </Card>
                )}
                {filtered.map((bill) => {
                  const extraTotal = chargesTotal(bill.charges);

                  return (
                    <Card key={bill.id}>
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          className="min-w-0 text-left"
                          onClick={() => onOpen(bill)}
                        >
                          <span className="block font-medium text-charcoal">
                            {bill.roomNumber}
                          </span>
                          <span className="block text-xs text-fog">
                            {bill.tenantName}
                          </span>
                        </button>
                        <StatusBadge status={bill.status} />
                      </div>
                      <div className="mt-3 border-t border-ash pt-3">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm text-steel">ยอดรวม</span>
                          <span className="num text-lg text-charcoal">
                            {baht(bill.total)} บาท
                          </span>
                        </div>
                        <dl className="mt-2 grid grid-cols-3 gap-2">
                          <div>
                            <dt className="text-[0.6875rem] text-fog">ค่าน้ำ</dt>
                            <dd className="mt-0.5 text-sm text-charcoal">
                              <Money value={bill.waterAmount} />
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[0.6875rem] text-fog">ค่าไฟ</dt>
                            <dd className="mt-0.5 text-sm text-charcoal">
                              <Money value={bill.electricAmount} />
                            </dd>
                          </div>
                          <div>
                            <dt className="text-[0.6875rem] text-fog">
                              ค่าใช้จ่ายเพิ่ม
                            </dt>
                            <dd className="mt-0.5 text-sm text-charcoal">
                              {extraTotal === 0 ? (
                                "—"
                              ) : (
                                <Money value={extraTotal} />
                              )}
                            </dd>
                          </div>
                        </dl>
                      </div>
                      <dl className="mt-3 grid gap-1.5 border-t border-ash pt-3">
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-[0.6875rem] text-fog">มิเตอร์น้ำ</dt>
                          <dd className="text-xs">
                            <MeterReading
                              previous={bill.waterPrevious}
                              current={bill.waterCurrent}
                              units={bill.waterUnits}
                              withUnit
                            />
                          </dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-[0.6875rem] text-fog">มิเตอร์ไฟ</dt>
                          <dd className="text-xs">
                            <MeterReading
                              previous={bill.electricPrevious}
                              current={bill.electricCurrent}
                              units={electricUnitsOf(bill)}
                              withUnit
                            />
                          </dd>
                        </div>
                      </dl>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <LineStateBadge
                          sentAt={bill.sentAt}
                          connected={connectedOf(bill)}
                        />
                        {bill.electricMode === "flat" && (
                          <span className="chip">ไฟเหมา</span>
                        )}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => onOpen(bill)}
                        >
                          ดูบิล
                        </Button>
                        {bill.status === "paid" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            icon="receipt_long"
                            onClick={() => setSlipBill(bill)}
                          >
                            ดูสลิป
                          </Button>
                        )}
                        {bill.status === "unpaid" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            icon="send"
                            disabled={
                              connectedOf(bill) === false ||
                              sendingId === bill.id
                            }
                            title={sendReason(bill)}
                            onClick={() => onSend(bill)}
                          >
                            {sendingId === bill.id ? "กำลังส่ง" : "ส่ง LINE"}
                          </Button>
                        )}
                        {bill.status === "unpaid" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="more_horiz"
                            onClick={() => onManage(bill)}
                          >
                            จัดการ
                          </Button>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
      <BillSlipDialog
        bill={slipBill}
        onClose={() => {
          setSlipBill(null);
        }}
      />
    </div>
  );
}

export function BillsPage({ view }: PageProps) {
  const [target] = useState<BillsRouteTarget>(() =>
    billsTargetOf(window.location.hash),
  );
  const [periods, setPeriods] = useState<string[]>(() =>
    target.period === "" ? [] : [target.period],
  );
  const [period, setPeriod] = useState<string>(target.period);
  const [roomFilter, setRoomFilter] = useState<string>(target.roomNumber);
  const [detailId, setDetailId] = useState<string | null>(target.billId);
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [statusFilter, setStatusFilter] = useState("all");
  const [tenantList, setTenantList] = useState<Tenant[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [menuBillId, setMenuBillId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<Bill | null>(null);
  const [payTarget, setPayTarget] = useState<Bill | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Bill | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  // ตัวจริงที่กันกดซ้ำ: state ใช้แค่แสดงผล เพราะอ่านค่าไม่ทันในคลิกเดียวกัน
  const sendingRef = useRef<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkResend, setBulkResend] = useState(false);
  const [bulkSending, setBulkSending] = useState(false);
  const [sendResult, setSendResult] = useState<SendAllResult | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    let active = true;

    void fetchTenants()
      .then((list) => {
        if (active) {
          setTenantList(list);
        }
      })
      .catch(() => {
        if (active) {
          setTenantList(null);
        }
      });

    void fetchSettings()
      .then((value) => {
        if (active) {
          setSettings(value);
        }
      })
      .catch(() => {
        if (active) {
          setSettings(null);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    const apply = (billed: string[]) => {
      const list = periodOptions(billed);

      setPeriods((prev) => {
        const missing = prev.filter((option) => !list.includes(option));
        return missing.length === 0
          ? list
          : [...missing, ...list].sort().reverse();
      });
      setPeriod((current) => (current === "" ? (list[0] ?? "") : current));
    };

    void fetchBillPeriods()
      .then((billed) => {
        if (active) {
          apply(billed);
        }
      })
      .catch(() => {
        if (active) {
          apply([]);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const syncFromHash = () => {
      const next = billsTargetOf(window.location.hash);

      setRoomFilter(next.roomNumber);

      if (next.period !== "") {
        setPeriods((prev) =>
          prev.includes(next.period) ? prev : [next.period, ...prev],
        );
        setPeriod(next.period);
      }

      setDetailId(next.billId);
    };

    window.addEventListener("hashchange", syncFromHash);

    return () => {
      window.removeEventListener("hashchange", syncFromHash);
    };
  }, []);

  useEffect(() => {
    if (period === "") {
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    void fetchBills(period)
      .then((list) => {
        if (active) {
          setBills(list);
        }
      })
      .catch((loadError: unknown) => {
        if (!active) {
          return;
        }

        setBills([]);
        setError(
          loadError instanceof ApiError
            ? loadError.message
            : "โหลดข้อมูลบิลไม่สำเร็จ",
        );
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [period, reloadKey]);

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

  const refresh = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

  // ตัวสร้างบิลและหน้าอื่นแก้ชุดบิลได้ ต้องดึงรายการใหม่ ไม่ให้ค้างของเก่า
  useEffect(() => {
    window.addEventListener(billsChangedEvent, refresh);

    return () => {
      window.removeEventListener(billsChangedEvent, refresh);
    };
  }, [refresh]);

  const applyBill = useCallback((updated: Bill) => {
    setBills((prev) =>
      prev.map((bill) => (bill.id === updated.id ? updated : bill)),
    );
  }, []);

  const connectedIds =
    tenantList === null
      ? null
      : new Set(
          tenantList
            .filter((tenant) => tenant.lineUserId !== null)
            .map((tenant) => tenant.id),
        );

  const go = (hash: string) => {
    window.location.hash = hash;
  };

  const replaceFocusHash = useCallback(
    (roomNumber: string, nextPeriod: string) => {
      window.history.replaceState(null, "", listHash(roomNumber, nextPeriod));
    },
    [],
  );

  const menuBill = bills.find((bill) => bill.id === menuBillId) ?? null;
  const detailBill =
    detailId === null
      ? null
      : (bills.find((bill) => bill.id === detailId) ?? null);

  const handleSaved = (message: string) => (updated: Bill) => {
    setEditTarget(null);
    setPayTarget(null);
    applyBill(updated);
    refresh();
    setToast(message);
  };

  const handleSendOne = (bill: Bill) => {
    // กันกดซ้ำจากเมนูหรือปุ่มในตารางพร้อมกัน ซึ่งจะส่งบิลใบเดิมสองครั้ง
    // ต้องกันด้วย ref เพราะ state ยังไม่ทันอัปเดตภายในคีย์เดียวกัน
    if (sendingRef.current !== null) {
      return;
    }

    if (connectedIds !== null && !connectedIds.has(bill.tenantId)) {
      setToast("ผู้เช่ารายนี้ยังไม่เชื่อม LINE ส่งบิลไม่ได้");
      return;
    }

    sendingRef.current = bill.id;
    setSendingId(bill.id);

    void sendBill(bill.id)
      .then((updated) => {
        applyBill(updated);
        refresh();
        setToast(`ส่งบิลห้อง ${updated.roomNumber} ทาง LINE แล้ว`);
      })
      .catch((error: unknown) => {
        setToast(
          error instanceof ApiError
            ? error.message
            : "ส่งบิลทาง LINE ไม่สำเร็จ",
        );
      })
      .finally(() => {
        sendingRef.current = null;
        setSendingId(null);
      });
  };

  const runBulkSend = (billIds: string[]) => {
    if (billIds.length === 0) {
      return;
    }

    setBulkSending(true);

    void sendBills(period, billIds)
      .then((result) => {
        setSendResult(result);
        setBulkOpen(false);
        refresh();
        setToast(sendResultLabel(result));
      })
      .catch((error: unknown) => {
        setToast(
          error instanceof ApiError
            ? error.message
            : "ส่งบิลทาง LINE ไม่สำเร็จ",
        );
      })
      .finally(() => {
        setBulkSending(false);
      });
  };

  const scopedBills =
    roomFilter === ""
      ? bills
      : bills.filter((bill) => bill.roomNumber === roomFilter);
  const pendingBills = scopedBills.filter(
    (bill) => bill.status === "unpaid" && bill.sentAt === null,
  );
  const sentBills = scopedBills.filter(
    (bill) => bill.status === "unpaid" && bill.sentAt !== null,
  );
  const paidBills = scopedBills.filter((bill) => bill.status === "paid");
  const pendingTargets =
    connectedIds === null
      ? pendingBills
      : pendingBills.filter((bill) => connectedIds.has(bill.tenantId));
  const resendTargets =
    connectedIds === null
      ? sentBills
      : sentBills.filter((bill) => connectedIds.has(bill.tenantId));
  const unlinkedPending =
    connectedIds === null
      ? null
      : pendingBills.filter((bill) => !connectedIds.has(bill.tenantId));
  const bulkTargets = bulkResend
    ? [...pendingTargets, ...resendTargets]
    : pendingTargets;

  const handleSendAll = () => {
    setBulkResend(false);
    setBulkOpen(true);
  };

  const handleRetryFailed = () => {
    if (sendResult === null || sendResult.failedIds.length === 0) {
      return;
    }

    runBulkSend(sendResult.failedIds);
  };

  if (view === "create") {
    return (
      <CreateWizard
        settings={settings}
        tenants={tenantList}
        onFinish={() => {
          go("#bills");
        }}
      />
    );
  }

  if (view === "detail") {
    if (detailBill === null) {
      if (loading) {
        return (
          <Card>
            <div className="grid gap-3" aria-busy="true">
              <Skeleton className="h-5 w-44" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          </Card>
        );
      }

      return (
        <Card>
          <EmptyState
            icon="receipt_long"
            title="ไม่พบบิลที่จะแสดง"
            description="บิลนี้อาจถูกลบไปแล้ว หรือลิงก์มาไม่ครบ กลับไปเลือกรอบบิลแล้วเปิดบิลอีกครั้ง"
            action={
              <Button
                variant="secondary"
                icon="arrow_back"
                onClick={() => {
                  go(listHash(roomFilter, period));
                }}
              >
                กลับรายการบิล
              </Button>
            }
          />
        </Card>
      );
    }

    return (
      <BillDetail
        bill={detailBill}
        dormName={settings?.dormName ?? null}
        ownerName={settings?.ownerName ?? null}
        promptpayId={settings?.promptpayId ?? null}
        connected={
          connectedIds === null ? null : connectedIds.has(detailBill.tenantId)
        }
        onBack={() => {
          go(listHash(roomFilter, period));
        }}
        onSaved={(updated) => {
          applyBill(updated);
          refresh();
          setToast(updated.status === "paid" ? "ปิดบิลแล้ว" : "บันทึกบิลแล้ว");
        }}
        onSent={(updated) => {
          applyBill(updated);
          refresh();
          setToast(`ส่งบิลห้อง ${updated.roomNumber} ทาง LINE แล้ว`);
        }}
        onSendError={(message) => {
          setToast(message);
        }}
        onDeleted={() => {
          setBills((prev) => prev.filter((bill) => bill.id !== detailBill.id));
          refresh();
          setToast("ลบบิลแล้ว");
          go(listHash(roomFilter, period));
        }}
      />
    );
  }

  return (
    <>
      <BillList
        bills={bills}
        loading={loading}
        error={error}
        period={period}
        periods={periods}
        connectedIds={connectedIds}
        statusFilter={statusFilter}
        roomFilter={roomFilter}
        onPeriodChange={(value) => {
          setPeriod(value);
          replaceFocusHash(roomFilter, value);
        }}
        onStatusFilterChange={setStatusFilter}
        onClearRoom={() => {
          setRoomFilter("");
          replaceFocusHash("", period);
        }}
        onOpen={(bill) => {
          go(detailHash(bill.id, period, roomFilter));
        }}
        onManage={(bill) => {
          setMenuBillId(bill.id);
        }}
        onSend={handleSendOne}
        onSendAll={handleSendAll}
        onRetryFailed={handleRetryFailed}
        onDismissResult={() => {
          setSendResult(null);
        }}
        sendingId={sendingId}
        bulkSending={bulkSending}
        sendResult={sendResult}
        onCreate={() => {
          go("#bills/create");
        }}
        onExport={() => {
          setExportOpen(true);
        }}
        onRetry={refresh}
      />

      <ExportBillsDialog
        open={exportOpen}
        onClose={() => {
          setExportOpen(false);
        }}
        currentPeriod={period}
        onDone={setToast}
      />

      <Dialog
        open={bulkOpen}
        onClose={() => {
          setBulkOpen(false);
          setBulkResend(false);
        }}
        title={`ส่งบิลทาง LINE · ${periodLabel(period)}`}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setBulkOpen(false);
                setBulkResend(false);
              }}
            >
              ยกเลิก
            </Button>
            <Button
              variant="primary"
              icon="send"
              disabled={bulkSending || bulkTargets.length === 0}
              onClick={() => {
                runBulkSend(bulkTargets.map((bill) => bill.id));
              }}
            >
              {bulkSending
                ? "กำลังส่งบิล"
                : bulkTargets.length === 0
                  ? "ไม่มีบิลที่ต้องส่ง"
                  : bulkResend
                    ? `ส่ง ${bulkTargets.length} ใบ`
                    : `ส่งเฉพาะ ${bulkTargets.length} ใบที่ยังไม่ส่ง`}
            </Button>
          </div>
        }
      >
        <div className="grid gap-3 text-sm">
          <p className="text-steel">
            ระบบจะส่งใบแจ้งหนี้ให้ผู้เช่าที่เชื่อม LINE แล้ว
            และส่งสรุปยอดให้เจ้าของทาง LINE
          </p>
          {roomFilter !== "" && (
            <p className="text-charcoal">{`ส่งเฉพาะบิลของห้อง ${roomFilter}`}</p>
          )}
          <p className="text-charcoal">{`จะส่งบิล ${bulkTargets.length} ใบ`}</p>

          <ul className="grid gap-2 rounded-lg border border-ash p-3">
            <li className="flex items-start justify-between gap-3">
              <span className="text-steel">ยังไม่ส่ง</span>
              <span className="num text-charcoal">{`${pendingBills.length} ใบ`}</span>
            </li>
            <li className="flex items-start justify-between gap-3">
              <span className="text-steel">ส่งแล้ว</span>
              <span className="num text-charcoal">{`${sentBills.length} ใบ`}</span>
            </li>
            <li className="flex items-start justify-between gap-3">
              <span className="text-steel">
                จ่ายแล้ว
                <span className="mt-0.5 block text-[0.6875rem] text-fog">
                  ระบบไม่ส่งบิลที่จ่ายแล้ว
                </span>
              </span>
              <span className="num text-charcoal">{`${paidBills.length} ใบ`}</span>
            </li>
            <li className="flex items-start justify-between gap-3">
              <span className="text-steel">
                ยังไม่เชื่อม LINE
                <span className="mt-0.5 block text-[0.6875rem] text-fog">
                  ส่งไม่ได้จนกว่าจะเชื่อม LINE
                </span>
              </span>
              <span className="num text-charcoal">
                {unlinkedPending === null
                  ? "ไม่ทราบ"
                  : `${unlinkedPending.length} ห้อง`}
              </span>
            </li>
          </ul>

          {unlinkedPending !== null && unlinkedPending.length > 0 && (
            <p className="text-fog">
              {`ยังไม่เชื่อม LINE ${unlinkedPending.length} ห้อง: ${unlinkedPending.map((bill) => `${bill.roomNumber} ${bill.tenantName}`).join(" · ")}`}
            </p>
          )}
          {unlinkedPending === null && (
            <p className="text-fog">
              ยังไม่ทราบสถานะ LINE ของผู้เช่า ระบบจะข้ามห้องที่ยังไม่เชื่อม LINE
              ให้เอง
            </p>
          )}

          <label className="flex items-start gap-3 rounded-lg border border-ash p-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={bulkResend}
              disabled={resendTargets.length === 0}
              onChange={(event) => {
                setBulkResend(event.target.checked);
              }}
            />
            <span className="min-w-0">
              <span className="block text-charcoal">{`ส่งซ้ำให้บิลที่ส่งแล้วแต่ยังไม่จ่าย ${resendTargets.length} ใบ`}</span>
              <span className="mt-0.5 block text-[0.6875rem] text-fog">
                ใช้เมื่อต้องการแจ้งยอดเดิมซ้ำเท่านั้น
                ผู้เช่าจะได้รับใบแจ้งหนี้อีกครั้ง
              </span>
            </span>
          </label>

          {bulkResend && (
            <p className="flex items-start gap-1.5 text-xs text-danger">
              <span className="ms text-[0.875rem]" aria-hidden="true">
                warning
              </span>
              {`กำลังส่งซ้ำให้บิลที่ส่งแล้ว ${resendTargets.length} ใบ ผู้เช่าจะได้รับใบแจ้งหนี้อีกครั้ง`}
            </p>
          )}
        </div>
      </Dialog>

      <Dialog
        open={menuBill !== null}
        onClose={() => {
          setMenuBillId(null);
        }}
        title={
          menuBill === null
            ? "จัดการบิล"
            : `จัดการบิลห้อง ${menuBill.roomNumber}`
        }
        footer={
          <Button
            variant="ghost"
            onClick={() => {
              setMenuBillId(null);
            }}
          >
            ปิด
          </Button>
        }
      >
        {menuBill !== null && (
          <div className="grid gap-2">
            <Button
              variant="secondary"
              icon="edit"
              className="w-full justify-start"
              onClick={() => {
                setEditTarget(menuBill);
                setMenuBillId(null);
              }}
            >
              แก้ไขบิล
            </Button>
            <Button
              variant="secondary"
              icon="check_circle"
              className="w-full justify-start"
              onClick={() => {
                setPayTarget(menuBill);
                setMenuBillId(null);
              }}
            >
              ปิดบิลด้วยมือ
            </Button>
            <Button
              variant="secondary"
              icon="send"
              className="w-full justify-start"
              disabled={
                sendingId !== null ||
                (connectedIds !== null && !connectedIds.has(menuBill.tenantId))
              }
              title={
                connectedIds !== null && !connectedIds.has(menuBill.tenantId)
                  ? "ผู้เช่ายังไม่เชื่อม LINE"
                  : undefined
              }
              onClick={() => {
                const target = menuBill;
                setMenuBillId(null);
                handleSendOne(target);
              }}
            >
              {sendingId === menuBill.id ? "กำลังส่ง" : "ส่ง LINE อีกครั้ง"}
            </Button>
            <Button
              variant="danger-soft"
              icon="delete"
              className="mt-2 w-full justify-start"
              onClick={() => {
                setDeleteTarget(menuBill);
                setMenuBillId(null);
              }}
            >
              ลบบิล
            </Button>
          </div>
        )}
      </Dialog>

      <BillEditDrawer
        open={editTarget !== null}
        bill={editTarget}
        onClose={() => {
          setEditTarget(null);
        }}
        onSaved={handleSaved("บันทึกบิลแล้ว")}
      />

      <MarkPaidDialog
        open={payTarget !== null}
        bill={payTarget}
        onClose={() => {
          setPayTarget(null);
        }}
        onPaid={handleSaved("ปิดบิลแล้ว")}
      />

      <DeleteBillDialog
        open={deleteTarget !== null}
        bill={deleteTarget}
        onClose={() => {
          setDeleteTarget(null);
        }}
        onDeleted={() => {
          if (deleteTarget !== null) {
            const removedId = deleteTarget.id;
            setBills((prev) => prev.filter((bill) => bill.id !== removedId));
          }

          setDeleteTarget(null);
          refresh();
          setToast("ลบบิลแล้ว");
        }}
      />

      <Toast message={toast ?? ""} open={toast !== null} />
    </>
  );
}
