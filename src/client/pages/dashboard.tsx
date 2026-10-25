import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ApiError, billsChangedEvent, billsFocusHash, fetchBillPeriods, fetchDashboardStats, tenantsChangedEvent, type DashboardRoom, type DashboardStats } from "../api";
import { periodAt, periodLabel, periodOptions } from "../period";
import { Button, Card, EmptyState, PageHeader, Skeleton } from "../ui";
import { baht } from "./bills-shared";
import { RevenueChart, type MonthlyRevenue } from "./dashboard-chart";

type TileStatus = "vacant" | "arrears" | "review" | "paid" | "waiting";

const tileMeta: Record<TileStatus, string> = {
  vacant: "ว่าง",
  arrears: "ค้างชำระ",
  review: "รอตรวจยอด",
  paid: "ชำระแล้ว",
  waiting: "รอชำระ",
};
const tileOrder: TileStatus[] = ["vacant", "review", "arrears", "paid", "waiting"];
const thaiMonthsShort = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

function tileStatus(room: DashboardRoom): TileStatus {
  if (room.status === "vacant") return "vacant";
  if (room.arrears.periods.length > 0) return "arrears";
  if (room.hasMismatchSlip) return "arrears";
  if (room.hasPendingSlip) return "review";
  if (room.status === "paid") return "paid";
  return "waiting";
}

function tileHref(room: DashboardRoom, period: string): string {
  const status = tileStatus(room);
  if (status === "vacant") return "#rooms";
  if (status === "arrears" && room.arrears.periods.length > 0) {
    return billsFocusHash({ roomNumber: room.roomNumber, period: room.arrears.periods[0] ?? period });
  }
  if (status === "review" || room.hasMismatchSlip) return "#review";
  if (room.status === "unbilled") return `#bills/create?period=${encodeURIComponent(period)}`;
  return billsFocusHash({ roomNumber: room.roomNumber, period });
}

export function DashboardPage() {
  const [selectedPeriod, setSelectedPeriod] = useState(() => periodAt(0));
  const [billedPeriods, setBilledPeriods] = useState<string[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setStats(null);
    setError(null);
    void fetchDashboardStats(selectedPeriod)
      .then((data) => { if (active) setStats(data); })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof ApiError ? loadError.message : "โหลดข้อมูลแดชบอร์ดไม่สำเร็จ");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selectedPeriod, reloadKey]);

  useEffect(() => {
    let active = true;
    void fetchBillPeriods().then((list) => { if (active) setBilledPeriods(list); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const refresh = () => setReloadKey((value) => value + 1);
    window.addEventListener(billsChangedEvent, refresh);
    window.addEventListener(tenantsChangedEvent, refresh);
    return () => {
      window.removeEventListener(billsChangedEvent, refresh);
      window.removeEventListener(tenantsChangedEvent, refresh);
    };
  }, []);

  const retry = useCallback(() => setReloadKey((value) => value + 1), []);
  const periods = useMemo(() => {
    const list = periodOptions(billedPeriods);
    return list.includes(selectedPeriod) ? list : [selectedPeriod, ...list].sort().reverse();
  }, [billedPeriods, selectedPeriod]);

  const rooms = stats?.rooms ?? [];
  const occupied = rooms.filter((room) => room.status !== "vacant").length;
  const vacant = rooms.length - occupied;
  const occupancy = rooms.length > 0 ? Math.round((occupied / rooms.length) * 100) : 0;
  const counts: Record<TileStatus, number> = { vacant: 0, arrears: 0, review: 0, paid: 0, waiting: 0 };
  for (const room of rooms) counts[tileStatus(room)] += 1;
  const noLine = rooms.filter((room) => room.status !== "vacant" && !room.hasLine).length;
  const revenuePoints: MonthlyRevenue[] = (stats?.revenue ?? []).map((point) => ({
    period: point.period,
    label: thaiMonthsShort[Number(point.period.slice(5)) - 1] ?? point.period,
    amount: point.amount,
    unpaidAmount: point.unpaidAmount,
    hasBills: point.hasBills,
  }));

  return (
    <div className="dashboard-page">
      <PageHeader title="แดชบอร์ด" supporting={`ภาพรวมหอพัก · ${periodLabel(selectedPeriod)}`} actions={
        <div className="flex items-center gap-2">
          <label className="field-label mb-0" htmlFor="dashboard-month">เดือน</label>
          <select id="dashboard-month" className="input w-auto" value={selectedPeriod} onChange={(event) => { setStats(null); setLoading(true); setSelectedPeriod(event.target.value); }}>
            {periods.map((period) => <option key={period} value={period}>{periodLabel(period)}</option>)}
          </select>
        </div>
      } />

      {loading ? (
        <div aria-busy="true" className="dashboard-charts">
          <Card><Skeleton className="h-64 w-full" /></Card>
          <Card><Skeleton className="h-64 w-full" /></Card>
        </div>
      ) : error !== null ? (
        <Card><EmptyState icon="cloud_off" title="โหลดข้อมูลแดชบอร์ดไม่สำเร็จ" description={error} action={<Button variant="secondary" icon="refresh" onClick={retry}>ลองใหม่</Button>} /></Card>
      ) : stats !== null ? (
        <>
          <div className="dashboard-charts">
            <Card>
              <h2 className="dashboard-card-title">การเข้าพัก</h2>
              <p className="dashboard-card-description">ห้องที่มีผู้เช่าเทียบกับห้องทั้งหมด</p>
              <div className="dashboard-occupancy">
                <div className="dashboard-donut" style={{ "--occupied-percent": `${occupied / (rooms.length || 1) * 100}%` } as CSSProperties} role="img" aria-label={`เข้าพัก ${occupied} จาก ${rooms.length} ห้อง คิดเป็น ${occupancy} เปอร์เซ็นต์`}>
                  <div className="dashboard-donut-center"><strong className="num">{occupancy}%</strong><span>เข้าพัก</span></div>
                </div>
                <div className="dashboard-occupancy-legend">
                  <div><span><i className="dashboard-key-dot dashboard-key-collected" />มีผู้เช่า</span><strong className="num">{occupied} ห้อง</strong></div>
                  <div><span><i className="dashboard-key-dot dashboard-key-vacant" />ว่าง</span><strong className="num">{vacant} ห้อง</strong></div>
                  <div className="dashboard-occupancy-total"><span>รวม</span><strong className="num">{rooms.length} ห้อง</strong></div>
                </div>
              </div>
            </Card>
            <Card>
              <h2 className="dashboard-card-title">รายรับ 6 เดือน</h2>
              <p className="dashboard-card-description">แท่งสีเข้มคือเดือนที่เลือก · ส่วนสีส้มคือยอดที่ยังเก็บไม่ได้</p>
              <RevenueChart points={revenuePoints} highlight={selectedPeriod} />
            </Card>
          </div>

          <Card className="dashboard-room-card">
            <div className="dashboard-room-heading">
              <h2 className="dashboard-card-title">ผังห้อง · {periodLabel(selectedPeriod)}</h2>
              <div className="dashboard-room-key" aria-label="จำนวนห้องตามสถานะ">
                {tileOrder.map((status) => <span key={status}><i className={`dashboard-key-square is-${status}`} />{status === "waiting" ? "รอชำระ / ยังไม่ออกบิล" : status === "arrears" ? "ยอดไม่ตรง / ค้างชำระ" : tileMeta[status]} <b className="num">{counts[status]}</b></span>)}
                {noLine > 0 && <span><span className="ms" aria-hidden="true">link_off</span> ไม่มี LINE <b className="num">{noLine}</b></span>}
              </div>
            </div>
            {rooms.length === 0 ? (
              <EmptyState icon="door_front" title="ยังไม่มีห้องในระบบ" description="เพิ่มห้องที่หน้าห้องพัก แล้วกลับมาดูภาพรวมที่นี่" action={<Button variant="secondary" icon="door_front" onClick={() => { window.location.hash = "#rooms"; }}>ไปหน้าห้องพัก</Button>} />
            ) : (
              <ul className="dashboard-room-grid">
                {rooms.map((room) => {
                  const status = tileStatus(room);
                  const label = room.status === "unbilled" && status === "waiting" ? "ยังไม่ออกบิล" : room.hasMismatchSlip && room.arrears.periods.length === 0 ? "ยอดไม่ตรง" : tileMeta[status];
                  const arrears = room.arrears.periods.length > 0 ? `ค้างงวด ${room.arrears.periods.map(periodLabel).join(", ")} รวม ${baht(room.arrears.amount)} บาท` : null;
                  const accessible = [`ห้อง ${room.roomNumber}`, label, arrears, !room.hasLine && room.status !== "vacant" ? "ยังไม่เชื่อม LINE" : null].filter(Boolean).join(" · ");
                  return <li key={room.id}>
                    <a href={tileHref(room, selectedPeriod)} className={`dashboard-room-tile is-${status}`} aria-label={accessible} title={accessible}>
                      <strong className="dashboard-room-number num">{room.roomNumber}</strong>
                      <span className="dashboard-room-status">{label}</span>
                      {!room.hasLine && room.status !== "vacant" && <span className="dashboard-no-line ms" aria-hidden="true">link_off</span>}
                    </a>
                  </li>;
                })}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
