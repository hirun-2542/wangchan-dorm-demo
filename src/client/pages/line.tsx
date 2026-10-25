import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import {
  ApiError,
  fetchLineMessages,
  type LineLastSent,
  type LineMessageKind,
  type LineMessageSource,
} from "../api";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  Skeleton,
} from "../ui";
import { periodLabel } from "../period";

function isArrowKey(key: string): boolean {
  return (
    key === "ArrowRight" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowUp"
  );
}

/**
 * `bills.sent_at` เก็บเป็น SQLite datetime ("YYYY-MM-DD HH:MM:SS" UTC) หรือ ISO
 * จึงต้องเติม `Z` ก่อน parse ไม่งั้นเบราว์เซอร์ที่ UTC+7 จะตีความผิดเป็นเวลาไทย
 */
function formatSentAt(value: string): string {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** จุดตัดเดียวกับ `lg:` ของ Tailwind ที่เปลี่ยน tablist เป็นแนวตั้ง */
const desktopTabsQuery = "(min-width: 1024px)";

/**
 * ตัวกรองผู้รับ — แกนที่เจ้าของหอสนใจที่สุดในหน้านี้
 *
 * การ์ดของผู้เช่ากับของเจ้าของปนกันในลิสต์เดียวตามลำดับที่ server ส่งมา
 * (การ์ดเจ้าของอยู่ตำแหน่ง 3, 10, 11) จึงต้องมีทางกรองให้ถึงของตัวเองในคลิกเดียว
 */
type AudienceFilter = "all" | "tenant" | "owner";

const audienceFilters = [
  { value: "all", label: "ทั้งหมด" },
  { value: "tenant", label: "ถึงผู้เช่า" },
  { value: "owner", label: "ถึงเจ้าของ" },
] as const;

function useDesktopTabs(): boolean {
  const [desktop, setDesktop] = useState<boolean>(() =>
    typeof window === "undefined" ? true : window.matchMedia(desktopTabsQuery).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(desktopTabsQuery);
    const update = () => {
      setDesktop(media.matches);
    };

    media.addEventListener("change", update);

    return () => {
      media.removeEventListener("change", update);
    };
  }, []);

  return desktop;
}

type FlexRecord = Record<string, unknown>;

function isRecord(value: unknown): value is FlexRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function stringField(node: FlexRecord, key: string): string {
  const value = node[key];
  return typeof value === "string" ? value : "";
}

interface HeaderLine {
  text: string;
  color: string | null;
  size: string | null;
}

interface PreviewHeader {
  background: string | null;
  lines: HeaderLine[];
}

type PreviewItem =
  | {
      kind: "row";
      label: string;
      value: string;
      bold: boolean;
      size: string | null;
      color: string | null;
    }
  | { kind: "note"; text: string; size: string | null; color: string | null; align: "start" | "center" | "end" | null; bold: boolean }
  /**
   * กล่องแนวนอนที่ลูกไม่ใช่ข้อความล้วน (เช่น [vertical box + ปุ่มคัดลอก])
   *
   * ของจริงใน LINE เรนเดอร์ลูกตามสัดส่วน `flex` ของแต่ละตัว จึงต้องคงเป็นแถว
   * แนวนอน ไม่ใช่แตกเป็นรายการซ้อนกันในแนวตั้ง — ไม่งั้นปุ่มจะถูกยืดเต็มความกว้าง
   * กลายเป็นคนละเรื่องกับที่ผู้เช่าเห็น
   */
  | { kind: "row-group"; cells: RowGroupCell[] }
  | { kind: "separator" }
  | { kind: "image"; url: string; size: string | null }
  | {
      kind: "button";
      label: string;
      uri: string;
      actionType: string;
      clipboardText: string;
      color: string;
      style: string;
    };

/** ช่องหนึ่งในกล่องแนวนอน — `flex` ของ LINE ตัดสินว่าใครกินพื้นที่มากกว่ากัน */
interface RowGroupCell {
  items: PreviewItem[];
  flex: number | null;
}

/** ขนาดตัวอักษรของ Flex — LINE กำหนดเป็นชื่อ ไม่ใช่ px */
const textSizes: Record<string, number> = {
  xxs: 11,
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
  xxl: 24,
  "3xl": 30,
  "4xl": 36,
  "5xl": 40,
};

const imageSizes: Record<string, number> = {
  xxs: 40,
  xs: 60,
  sm: 80,
  md: 100,
  lg: 120,
  xl: 140,
  xxl: 180,
  "3xl": 240,
  "4xl": 300,
  "5xl": 360,
};

function sizeStyle(
  sizes: Record<string, number>,
  size: string | null,
): { fontSize: number } | undefined {
  if (size === null) {
    return undefined;
  }

  const px = sizes[size];

  return px === undefined ? undefined : { fontSize: px };
}

function colorOf(node: FlexRecord): string | null {
  const value = node.color;

  return typeof value === "string" ? value : null;
}

/** การจัดแนวนอนของข้อความใน Flex — LINE รับ "start" | "center" | "end" */
function alignOf(node: FlexRecord): "start" | "center" | "end" | null {
  const value = node.align;

  return value === "start" || value === "center" || value === "end" ? value : null;
}

function numberOf(node: FlexRecord, key: string): number | null {
  const value = node[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readHeader(node: FlexRecord | null): PreviewHeader {
  if (node === null) {
    return { background: null, lines: [] };
  }

  const backgroundValue = node.backgroundColor;
  const background =
    typeof backgroundValue === "string" ? backgroundValue : null;
  const lines: HeaderLine[] = [];

  for (const child of asArray(node.contents)) {
    if (isRecord(child) && child.type === "text") {
      const text = stringField(child, "text");

      if (text !== "") {
        lines.push({
          text,
          color: colorOf(child),
          size: stringField(child, "size") || null,
        });
      }
    }
  }

  return { background, lines };
}

function collectItems(nodes: unknown, items: PreviewItem[]): void {
  for (const raw of asArray(nodes)) {
    if (!isRecord(raw)) {
      continue;
    }

    const type = raw.type;

    switch (type) {
      case "separator":
        items.push({ kind: "separator" });
        break;

      case "text": {
        const text = stringField(raw, "text");

        if (text !== "") {
          items.push({
            kind: "note",
            text,
            size: stringField(raw, "size") || null,
            color: colorOf(raw),
            align: alignOf(raw),
            bold: raw.weight === "bold",
          });
        }

        break;
      }

      case "image":
        items.push({
          kind: "image",
          url: stringField(raw, "url"),
          size: stringField(raw, "size") || null,
        });
        break;

      case "button": {
        const action = isRecord(raw.action) ? raw.action : null;

        items.push({
          kind: "button",
          label: action === null ? "" : stringField(action, "label"),
          uri: action === null ? "" : stringField(action, "uri"),
          actionType: action === null ? "" : stringField(action, "type"),
          clipboardText:
            action === null ? "" : stringField(action, "clipboardText"),
          color: stringField(raw, "color"),
          style: stringField(raw, "style"),
        });
        break;
      }

      case "box": {
        if (raw.layout === "horizontal") {
          const children = asArray(raw.contents);
          const texts = children.filter(
            (child): child is FlexRecord =>
              isRecord(child) && child.type === "text",
          );
          const label = texts[0];
          const value = texts[1];

          if (
            label !== undefined &&
            value !== undefined &&
            children.every((child) => isRecord(child) && child.type === "text")
          ) {
            items.push({
              kind: "row",
              label: stringField(label, "text"),
              value: stringField(value, "text"),
              bold: value.weight === "bold",
              size: stringField(value, "size") || null,
              color: colorOf(value),
            });
            break;
          }

          /**
           * กล่องแนวนอนที่ลูกไม่ใช่ข้อความล้วน (เช่น [box ข้อความ + ปุ่มคัดลอก])
           *
           * LINE จัดเรียงลูกตามสัดส่วน `flex` ของแต่ละตัว ปุ่มที่ประกาศ `flex: 0`
           * จึงอยู่ท้ายบรรทัดที่ความกว้างตามเนื้อหา เดิมโค้ดไล่เก็บลูกทีละตัวลง
           * vertical grid ทำให้ปุ่มถูกยืดเต็มความกว้างทั้งแถบ — บิดของจริงมาก
           * ทั้งที่หน้าที่ของพรีวิวคือบอกว่าการ์ดหน้าตาเป็นอย่างไร
           */
          const cells: RowGroupCell[] = [];

          for (const child of children) {
            if (!isRecord(child)) {
              continue;
            }

            const cellItems: PreviewItem[] = [];
            collectItems([child], cellItems);

            if (cellItems.length > 0) {
              cells.push({ items: cellItems, flex: numberOf(child, "flex") });
            }
          }

          if (cells.length > 0) {
            items.push({ kind: "row-group", cells });
            break;
          }

          break;
        }

        collectItems(raw.contents, items);
        break;
      }

      default:
        items.push({
          kind: "note",
          text: `ไม่รองรับโหนด ${typeof type === "string" ? type : "ไม่ทราบชนิด"}`,
          size: null,
          color: null,
          align: null,
          bold: false,
        });
        break;
    }
  }
}

/**
 * `inline` = อยู่ภายในแถวแนวนอน (row-group) จึงต้องไม่ยืดเต็มความกว้าง
 * ของ LINE จริง ๆ ปุ่มที่ประกาศ `flex: 0` จะกว้างเท่าเนื้อหา ไม่ใช่เต็มแถว
 */
function PreviewItemView({
  item,
  inline = false,
}: {
  item: PreviewItem;
  inline?: boolean;
}) {
  switch (item.kind) {
    case "separator":
      return <div className="my-0.5 border-t border-ash" />;

    case "row-group":
      return (
        <div className="flex items-center gap-3">
          {item.cells.map((cell, index) => (
            <div
              key={`cell-${index}`}
              className={cell.flex === null || cell.flex === 0 ? "shrink-0" : "min-w-0 flex-1"}
            >
              {cell.items.map((cellItem, cellIndex) => (
                <PreviewItemView key={`cell-${index}-${cellIndex}`} item={cellItem} inline />
              ))}
            </div>
          ))}
        </div>
      );

    case "note":
      return (
        <p
          // Flex `weight: "bold"` ต้องได้น้ำหนักเดียวกับแถวข้อมูลที่ประกาศ bold
          className={`text-fog ${item.bold ? "font-semibold" : ""}`}
          style={{
            // LINE ไม่ระบุ size = sm (14px) ไม่ใช่ 12px
            ...sizeStyle(textSizes, item.size ?? "sm"),
            color: item.color ?? undefined,
            textAlign: item.align ?? undefined,
          }}
        >
          {item.text}
        </p>
      );

    case "row":
      return (
        <div className="flex items-start justify-between gap-3">
          <span className="text-sm text-steel">{item.label}</span>
          <span
            className={`num text-right ${item.bold ? "font-semibold" : ""}`}
            style={{
              ...sizeStyle(textSizes, item.size),
              color: item.color ?? "#171717",
            }}
          >
            {item.value}
          </span>
        </div>
      );

    case "image": {
      const px = item.size === null ? undefined : imageSizes[item.size];

      return (
        <div className="grid place-items-center rounded-lg border border-ash p-2">
          {item.url === "" ? (
            <p className="py-4 text-center text-xs text-fog">
              รูปภาพไม่ระบุ URL
            </p>
          ) : (
            <img
              src={item.url}
              alt="รูปภาพที่แนบในการ์ด"
              loading="lazy"
              decoding="async"
              className="rounded-lg border border-ash bg-paper-mist object-contain"
              style={
                px === undefined
                  ? { height: 128, width: 128 }
                  : { height: px, width: px }
              }
            />
          )}
        </div>
      );
    }

    case "button": {
      const label = item.label === "" ? "ปุ่ม" : item.label;
      const href = item.uri === "" ? undefined : item.uri;

      if (item.actionType === "clipboard") {
        return (
          <PreviewButton
            label={label}
            clipboardText={item.clipboardText}
            inline={inline}
          />
        );
      }

      if (item.style === "link") {
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={`text-sm text-charcoal underline underline-offset-2 ${inline ? "inline-block" : "block"}`}
          >
            {label}
          </a>
        );
      }

      if (item.style === "secondary") {
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={`rounded-lg border border-pebble px-3 py-1.5 text-center text-sm font-medium text-charcoal ${
              inline ? "inline-block" : "block"
            }`}
          >
            {label}
          </a>
        );
      }

      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={`rounded-lg px-4 py-2 text-center text-sm font-medium text-white ${
            inline ? "inline-block" : "block"
          }`}
          style={{
            // ค่า fallback ต้องตรงกับสีปุ่มหลักที่ server ส่งจริง (ink)
            backgroundColor: item.color === "" ? "#171717" : item.color,
          }}
        >
          {label}
        </a>
      );
    }
  }
}

/**
 * ปุ่มคัดลอกของการ์ดตัวอย่าง — ทำตาม convention เดียวกับ settings.tsx/family.tsx
 *
 * ต้องบอกว่าคัดลอกแล้วได้ก็ต่อเมื่อเบราว์เซอร์คัดลอกให้จริง และต้องบอกด้วยว่า
 * ล้มเหลว เพราะผู้ใช้ที่กดแล้วเงียบจะกดซ้ำหรือไม่กล้าใช้ปุ่มนี้อีก
 */
function PreviewButton({
  label,
  clipboardText,
  inline,
}: {
  label: string;
  clipboardText: string;
  inline: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!copied && !copyFailed) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 2000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [copied, copyFailed]);

  const text = copied ? "คัดลอกแล้ว" : copyFailed ? "คัดลอกไม่สำเร็จ" : label;

  return (
    <button
      type="button"
      className={`rounded-lg border px-3 py-1.5 text-center text-sm font-medium ${
        inline ? "inline-block" : "w-full"
      } ${
        copyFailed
          ? "border-danger/40 bg-danger-soft text-danger"
          : "border-pebble bg-canvas-white text-charcoal"
      }`}
      aria-label={`คัดลอก ${clipboardText}`}
      onClick={() => {
        // บอกว่าคัดลอกแล้วได้ก็ต่อเมื่อเบราว์เซอร์คัดลอกให้จริง
        void navigator.clipboard
          .writeText(clipboardText)
          .then(() => {
            setCopyFailed(false);
            setCopied(true);
          })
          .catch(() => {
            setCopied(false);
            setCopyFailed(true);
          });
      }}
    >
      <span className="flex items-center justify-center gap-1.5">
        <span className="ms text-[1rem]" aria-hidden="true">
          {copied ? "check" : copyFailed ? "error" : "content_copy"}
        </span>
        {text}
      </span>
    </button>
  );
}

function FlexPreview({ message }: { message: LineMessageKind["message"] }) {
  const bubble = isRecord(message.contents) ? message.contents : null;
  const headerNode =
    bubble === null ? null : isRecord(bubble.header) ? bubble.header : null;
  const header = readHeader(headerNode);
  const bodyItems: PreviewItem[] = [];
  const footerItems: PreviewItem[] = [];

  if (bubble !== null) {
    const body = isRecord(bubble.body) ? bubble.body : null;
    collectItems(body === null ? [] : body.contents, bodyItems);

    const footer = isRecord(bubble.footer) ? bubble.footer : null;
    collectItems(footer === null ? [] : footer.contents, footerItems);
  }

  return (
    // ตรึงชุดสีสว่างไว้ทั้งซับทรี (.line-preview ใน styles.css) เพราะการ์ดนี้จำลองหน้าตา
    // ข้อความจริงที่ผู้เช่าเห็นใน LINE — สีบางส่วนมาจาก JSON ที่ server ส่ง ไม่ใช่ token ของแอป
    <div className="line-preview overflow-hidden rounded-2xl border border-ash bg-canvas-white">
      {header.lines.length > 0 && (
        <div
          className="px-4 py-3"
          style={
            header.background === null
              ? undefined
              : { backgroundColor: header.background }
          }
        >
          {header.lines.map((line, index) => (
            <p
              key={`${line.text}-${index}`}
              className={index === 0 ? "font-medium" : "mt-0.5"}
              style={{
                ...sizeStyle(textSizes, line.size),
                color: line.color ?? undefined,
              }}
            >
              {line.text}
            </p>
          ))}
        </div>
      )}

      {bodyItems.length > 0 && (
        <div className="grid gap-1.5 px-4 py-3">
          {bodyItems.map((item, index) => (
            <PreviewItemView key={`body-${index}`} item={item} />
          ))}
        </div>
      )}

      {footerItems.length > 0 && (
        <div className="grid gap-1.5 border-t border-ash px-4 py-3">
          {footerItems.map((item, index) => (
            <PreviewItemView key={`footer-${index}`} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

export function LinePage() {
  const [messages, setMessages] = useState<LineMessageKind[]>([]);
  const [source, setSource] = useState<LineMessageSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState("");
  const [lastSent, setLastSent] = useState<LineLastSent | null>(null);
  const [audience, setAudience] = useState<AudienceFilter>("all");
  const desktopTabs = useDesktopTabs();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await fetchLineMessages();
      setMessages(result.messages);
      setSource(result.source);
      setLastSent(result.lastSent);
    } catch (loadError) {
      setMessages([]);
      setSource(null);
      setLastSent(null);
      setError(
        loadError instanceof ApiError
          ? loadError.message
          : "โหลดข้อความ LINE ไม่สำเร็จ",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ownerCount = messages.filter((item) => item.audience === "owner").length;
  const tenantCount = messages.length - ownerCount;
  const visible = audience === "all" ? messages : messages.filter((item) => item.audience === audience);

  /**
   * การ์ดที่แสดงต้องอยู่ในชุดที่กรองไว้เสมอ
   *
   * `activeKey` จำการ์ดที่เคยเลือกไว้ ถ้าผู้ใช้สลับตัวกรองแล้วการ์ดนั้นหลุดออกจากชุด
   * จะต้องตกกลับไปใบแรกของชุดใหม่ ไม่ใช่ค้างอยู่ที่การ์ดที่มองไม่เห็น
   */
  const active = (activeKey === "" ? undefined : visible.find((item) => item.key === activeKey)) ?? visible[0];

  const onTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (!isArrowKey(event.key)) {
      return;
    }

    event.preventDefault();
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (index + step + visible.length) % visible.length;
    const next = visible[nextIndex];

    if (next !== undefined) {
      setActiveKey(next.key);
      document.getElementById(`line-tab-${next.key}`)?.focus();
    }
  };

  const supporting = loading
    ? "กำลังโหลดข้อความ"
    : error !== null
      ? "โหลดข้อความไม่สำเร็จ"
      : `${messages.length} ข้อความที่บอทส่งเป็นข้อความการ์ด Flex`;

  return (
    <div>
      <PageHeader title="ข้อความ LINE" supporting={supporting} />

      {loading ? (
        <Card>
          <div className="grid gap-3" aria-busy="true">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-2/3" />
          </div>
        </Card>
      ) : error !== null ? (
        <Card>
          {/* ข่าวร้ายต้องถูกประกาศ ไม่ใช่แค่เปลี่ยนข้อความบนจอ */}
          <div role="alert">
            <EmptyState
              icon="cloud_off"
              title="โหลดข้อความ LINE ไม่สำเร็จ"
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
          </div>
        </Card>
      ) : active === undefined ? (
        <Card>
          <EmptyState
            icon="chat_bubble"
            title="ยังไม่มีข้อความที่บอทส่ง"
            description="ข้อความการ์ด Flex ของบอทจะแสดงที่นี่เมื่อระบบเริ่มส่งให้ผู้เช่าหรือเจ้าของ — เริ่มจากการออกบิลและกดส่งบิลให้ผู้เช่า"
            action={
              <Button
                variant="secondary"
                icon="receipt_long"
                onClick={() => {
                  window.location.hash = "#bills";
                }}
              >
                ไปหน้าบิล
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <Card className="min-w-0 lg:self-start">
            <CardHeader
              title="ข้อความที่บอทส่ง"
              description="เลือกเพื่อดูว่าใครได้รับ เมื่อไร และข้อความหน้าตาเป็นอย่างไร"
            />
            {/*
              ตัวกรองแบบ segmented — pattern เดียวกับหน้ารอตรวจและหน้าบิล
              (role="group" + aria-pressed + bg-status-unpaid-bg ของตัวที่เลือก)
              ยอดนับอยู่ในป้ายจึงรู้ทันทีว่ามีของเจ้าของกี่ใบโดยไม่ต้องเปิดดู
            */}
            <div
              role="group"
              aria-label="กรองตามผู้รับ"
              className="mb-3 flex gap-1 rounded-lg border border-ash p-1"
            >
              {audienceFilters.map((option) => {
                const selected = option.value === audience;
                const count =
                  option.value === "all"
                    ? messages.length
                    : option.value === "owner"
                      ? ownerCount
                      : tenantCount;

                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    className={`btn btn-sm flex-1 ${selected ? "bg-status-unpaid-bg font-medium text-deep-sapphire" : "text-steel hover:bg-paper-mist"}`}
                    onClick={() => {
                      setAudience(option.value);
                    }}
                  >
                    {`${option.label} ${count}`}
                  </button>
                );
              })}
            </div>
            {visible.length === 0 ? (
              <p className="py-6 text-center text-sm text-steel">
                ไม่มีข้อความที่ส่งถึง
                {audience === "owner" ? "เจ้าของหอ" : "ผู้เช่า"}
              </p>
            ) : null}
            <div
              role="tablist"
              aria-label="ข้อความ LINE ที่บอทส่ง"
              /**
               * ที่ ≥1024px รายการเรียงเป็นแนวตั้ง (lg:flex-col) แต่ค่า default ของ
               * tablist คือ horizontal จึงต้องประกาศ orientation ตามที่ผู้ใช้เห็น
               * ไม่ใช่ตามสไตล์ — คอมโพเนนต์นี้เลื่อนด้วยลูกศรทั้ง 4 ทิศอยู่แล้ว
               */
              aria-orientation={desktopTabs ? "vertical" : "horizontal"}
              className="flex gap-2 overflow-x-auto pb-1 pr-6 [mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)] lg:flex-col lg:overflow-visible lg:pb-0 lg:pr-0 lg:[mask-image:none]"
            >
              {visible.map((item, index) => {
                const selected = item.key === active.key;

                return (
                  <button
                    key={item.key}
                    id={`line-tab-${item.key}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls="line-panel"
                    tabIndex={selected ? 0 : -1}
                    onClick={() => {
                      setActiveKey(item.key);
                    }}
                    onKeyDown={(keyEvent) => {
                      onTabKeyDown(keyEvent, index);
                    }}
                    className={`min-h-11 shrink-0 rounded-lg border px-3 py-2 text-left transition-colors lg:w-full ${
                      selected
                        ? "border-pebble bg-paper-mist"
                        : "border-ash hover:bg-paper-mist"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium text-charcoal">
                        {item.title}
                      </span>
                      {/*
                        chip ใช้พื้น paper-mist เหมือนแถวที่ถูกเลือก จึงกลืนหาย
                        พอดีในแถวที่สำคัญที่สุด — สลับเป็นพื้นขาว+ขอบบนแถวนั้น
                      */}
                      <span className={`chip ${selected ? "chip-on-selected" : ""}`}>
                        {item.audience === "owner" ? "เจ้าของ" : "ผู้เช่า"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card>
            <div
              role="tabpanel"
              id="line-panel"
              aria-labelledby={`line-tab-${active.key}`}
              tabIndex={0}
            >
              <CardHeader
                title={active.title}
                description={active.trigger}
                actions={
                  /*
                    ผู้รับเป็น "แกน" ไม่ใช่ "สถานะ" จึงต้องไม่ยืมสีสถานะ — เดิมใช้
                    tone review (อำพัน) ซึ่งเป็นสีเดียวกับ badge รอตรวจในเมนูข้าง
                    ทำให้อำพันหมายสองอย่าง; แยกด้วยข้อความ+ไอคอนแทนสี
                  */
                  <Badge
                    tone="neutral"
                    icon={active.audience === "owner" ? "notifications_active" : "notifications"}
                  >
                    {active.audience === "owner"
                      ? "ถึงเจ้าของหอ"
                      : "ถึงผู้เช่า"}
                  </Badge>
                }
              />

              {/*
                หน้านี้สัญญาว่าตอบ "ใครได้รับ เมื่อไร" จึงต้องมีเวลาจริง
                ต่างจาก `source` ที่บอกแค่ว่าใช้บิลใบไหนเป็นตัวอย่าง
              */}
              <p className="mb-3 text-xs text-steel">
                {lastSent === null
                  ? "ยังไม่มีการส่งบิลในระบบ"
                  : `ส่งบิลล่าสุด ${formatSentAt(lastSent.sentAt)} · ห้อง ${lastSent.roomNumber} เดือน ${periodLabel(lastSent.period)}`}
              </p>

              <div className="rounded-2xl bg-paper-mist p-4">
                <div className="mx-auto max-w-[520px]">
                  <div className="mb-2 flex items-start gap-2 rounded-xl border border-ash bg-canvas-white px-3 py-2">
                    <span
                      className="ms mt-0.5 text-[1rem] text-steel"
                      aria-hidden="true"
                    >
                      notifications
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs text-fog">
                        {active.audience === "owner"
                          ? "ข้อความแจ้งเตือนที่เจ้าของหอเห็นก่อนเปิด"
                          : "ข้อความแจ้งเตือนที่ผู้เช่าเห็นก่อนเปิด"}
                      </p>
                      <p className="text-xs text-charcoal">
                        {active.message.altText}
                      </p>
                    </div>
                  </div>
                  <FlexPreview message={active.message} />
                </div>
                <p className="mt-2 text-center text-xs text-steel">
                  ข้อความการ์ด Flex ที่บอทส่งจริง · ส่งถึง
                  {active.audience === "owner" ? "เจ้าของหอ" : "ผู้เช่า"}
                  {source === null
                    ? ""
                    : ` · เนื้อหาตัวอย่างจากบิลห้อง ${source.roomNumber} เดือน ${periodLabel(source.period)}`}
                </p>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
