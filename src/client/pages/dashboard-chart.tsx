import { baht } from "./bills-shared";

export interface MonthlyRevenue {
  period: string;
  label: string;
  amount: number;
  unpaidAmount: number;
  hasBills: boolean;
}

export function RevenueChart({ points, highlight }: { points: MonthlyRevenue[]; highlight: string }) {
  const peak = Math.max(1, ...points.map((point) => point.amount + point.unpaidAmount));

  return (
    <div>
      <div className="dashboard-revenue-bars" aria-label="รายรับหกเดือน แยกเก็บได้และยังค้าง">
        {points.map((point) => {
          const total = point.amount + point.unpaidAmount;
          const height = total > 0 ? Math.max(4, (total / peak) * 78) : 0;
          const collectedHeight = total > 0 ? (point.amount / total) * 100 : 0;
          return (
            <div key={point.period} className="dashboard-revenue-column" title={`${point.period}: เก็บได้ ${baht(point.amount)} บาท · ยังค้าง ${baht(point.unpaidAmount)} บาท`}>
              <div className="dashboard-revenue-value num">
                {point.hasBills ? baht(point.amount) : "—"}
                {point.unpaidAmount > 0 && <span className="dashboard-outstanding num">+{baht(point.unpaidAmount)}</span>}
              </div>
              <div className={`dashboard-revenue-bar ${point.period === highlight ? "is-current" : ""}`} style={{ height: `${height}%` }}>
                {point.unpaidAmount > 0 && <div className="dashboard-revenue-unpaid" style={{ height: `${100 - collectedHeight}%` }} />}
                <div className="dashboard-revenue-collected" style={{ height: `${collectedHeight}%` }} />
              </div>
              <span className={`dashboard-revenue-label ${point.period === highlight ? "font-semibold" : ""}`}>{point.label}</span>
            </div>
          );
        })}
      </div>
      <div className="dashboard-chart-key">
        <span><i className="dashboard-key-dot dashboard-key-collected" /> เก็บได้แล้ว</span>
        <span><i className="dashboard-key-dot dashboard-key-outstanding" /> ยังไม่ได้รับ (ตามงวดบิล)</span>
      </div>
    </div>
  );
}
