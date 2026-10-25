import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ApiError,
  billsFocusHash,
  billsFocusTarget,
  createRoom,
  fetchDormCharges,
  fetchRooms,
  fetchSettings,
  fetchTenants,
  updateRoom,
  type DormCharge,
  type Room,
  type RoomInput,
  type Tenant,
} from "../api";
import { useSearch } from "../search";
import {
  Badge,
  Button,
  Card,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  Select,
  Skeleton,
  StatusBadge,
  Toast,
  type DataTableColumn,
} from "../ui";
import {
  baht,
  chargesTotal,
  chargeDrafts,
  isEmptyDraft,
  newChargeDraft,
  parseChargeAmount,
  type ChargeDraft,
} from "./bills-shared";
import { periodAt, periodLabel, recentPeriods } from "../period";
import { ChoiceRow, numericValue } from "./dorm-shared";
import { RoomPeaConnection } from "./rooms-pea";

type StatusFilter = "all" | "occupied" | "vacant";
type RoomView = "table" | "cards";
type WaterMode = "default" | "custom";
type ElectricChoice = "default" | "custom" | "flat";

interface RateDefaults {
  waterRate: number;
  electricRate: number;
}

interface RoomForm {
  id: string;
  rent: string;
  waterMeterInit: string;
  electricMeterInit: string;
  waterMode: WaterMode;
  waterRate: string;
  electricChoice: ElectricChoice;
  electricRate: string;
  /** id ของค่าใช้จ่ายระดับหอที่ห้องนี้ปิดไว้ */
  excludedDormChargeIds: string[];
  /** ค่าใช้จ่ายที่เป็นของห้องนี้เอง */
  ownCharges: ChargeDraft[];
}

const emptyRoomForm = (defaults: RateDefaults): RoomForm => ({
  id: "",
  rent: "",
  waterMeterInit: "0",
  electricMeterInit: "0",
  waterMode: "default",
  waterRate: String(defaults.waterRate),
  electricChoice: "default",
  electricRate: String(defaults.electricRate),
  excludedDormChargeIds: [],
  ownCharges: [],
});

const roomFormOf = (room: Room, defaults: RateDefaults): RoomForm => ({
  id: room.roomNumber,
  rent: String(room.rent),
  waterMeterInit: String(room.waterMeterInit),
  electricMeterInit: String(room.electricMeterInit),
  waterMode: room.waterRate === null ? "default" : "custom",
  waterRate: String(room.waterRate ?? defaults.waterRate),
  electricChoice:
    room.electricMode === "flat"
      ? "flat"
      : room.electricRate === null
        ? "default"
        : "custom",
  electricRate: String(room.electricRate ?? defaults.electricRate),
  excludedDormChargeIds: room.excludedDormChargeIds,
  ownCharges: chargeDrafts(room.ownCharges),
});

function waterRateText(room: Room, defaults: RateDefaults): string {
  return `${room.waterRate ?? defaults.waterRate} บาท/หน่วย`;
}

function electricText(room: Room, defaults: RateDefaults): string {
  if (room.electricMode === "flat") {
    if (room.lastElectricPeriod === null || room.lastElectricAmount === null) {
      return "เหมาจ่าย";
    }

    return `เหมาจ่าย ${moneyText(room.lastElectricAmount)}`;
  }

  return `${room.electricRate ?? defaults.electricRate} บาท/หน่วย`;
}

function moneyText(value: number): string {
  return `${baht(value)} บาท`;
}

function meterText(room: Room): string {
  return `น้ำ ${room.waterMeterInit.toLocaleString("en-US")} หน่วย · ไฟ ${room.electricMeterInit.toLocaleString("en-US")} หน่วย`;
}

function RoomMoney({
  room,
  label,
  children,
}: {
  room: Room;
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="num">
      <span className="sr-only">{`ห้อง ${room.roomNumber} ${label} `}</span>
      {children}
    </span>
  );
}

function RecurringCharges({
  room,
  align = "left",
}: {
  room: Room;
  align?: "left" | "right";
}) {
  return (
    <span
      className={`flex flex-col gap-1 ${align === "right" ? "items-end" : "items-start"}`}
    >
      <span className="sr-only">{`ห้อง ${room.roomNumber} ค่าใช้จ่ายประจำ `}</span>
      <span className="num text-sm text-charcoal">
        {moneyText(chargesTotal(room.charges))}
      </span>
      <span className="flex flex-wrap gap-1">
        {room.charges.map((charge) => (
          <span key={charge.name} className="chip">
            {charge.name}
          </span>
        ))}
      </span>
    </span>
  );
}

function rateValueClass(inherited: boolean): string {
  return inherited ? "num text-fog" : "num font-medium text-charcoal";
}

function rateTextClass(inherited: boolean, nowrap: boolean): string {
  return nowrap
    ? `${rateValueClass(inherited)} whitespace-nowrap`
    : rateValueClass(inherited);
}

function waterInherited(room: Room): boolean {
  return room.waterRate === null;
}

function electricInherited(room: Room): boolean {
  return room.electricMode === "meter" && room.electricRate === null;
}

function RoomStatusBadge({ room }: { room: Room }) {
  if (room.status === "vacant") {
    return <StatusBadge status="vacant" />;
  }

  return (
    <Badge tone="occupied" icon="person">
      มีผู้เช่า
    </Badge>
  );
}

function newestBilledPeriod(rooms: Room[]): string | null {
  let newest: string | null = null;

  for (const room of rooms) {
    const last = room.lastElectricPeriod;

    if (last !== null && (newest === null || last > newest)) {
      newest = last;
    }
  }

  return newest;
}

interface RoomMenuState {
  room: Room;
  trigger: HTMLElement;
  top: number;
  right: number;
}

interface RoomMenuProps {
  state: RoomMenuState;
  period: string | null;
  onClose: (restoreFocus: boolean) => void;
  onEdit: (room: Room) => void;
}

function RoomMenu({ state, period, onClose, onEdit }: RoomMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      onClose(true);
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (!(target instanceof Node)) {
        return;
      }

      if (
        ref.current?.contains(target) === true ||
        state.trigger.contains(target)
      ) {
        return;
      }

      onClose(false);
    };

    const onViewportChange = () => {
      onClose(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onViewportChange);
    window.addEventListener("resize", onViewportChange);
    document.addEventListener("pointerdown", onPointerDown, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onViewportChange);
      window.removeEventListener("resize", onViewportChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose, state.trigger]);

  const run = (action: (room: Room) => void) => {
    const room = state.room;
    onClose(false);
    action(room);
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`เมนูจัดการห้อง ${state.room.roomNumber}`}
      className="row-menu"
      style={{ top: state.top, right: state.right }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
          return;
        }

        event.preventDefault();
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLButtonElement>(
            "[role='menuitem']",
          ) ?? [],
        );
        const current = items.findIndex(
          (item) => item === document.activeElement,
        );
        const step = event.key === "ArrowDown" ? 1 : -1;
        items[(current + step + items.length) % items.length]?.focus();
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;

        if (
          next instanceof Node &&
          (ref.current?.contains(next) === true || next === state.trigger)
        ) {
          return;
        }

        onClose(false);
      }}
    >
      <button
        type="button"
        role="menuitem"
        className="row-menu-item"
        onClick={() => {
          run(onEdit);
        }}
      >
        <span className="ms text-[1.125rem]" aria-hidden="true">
          edit
        </span>
        แก้ไขห้อง
      </button>
      <button
        type="button"
        role="menuitem"
        className="row-menu-item"
        onClick={() => {
          run((room) => {
            window.location.hash = billsFocusHash(
              billsFocusTarget(room, period),
            );
          });
        }}
      >
        <span className="ms text-[1.125rem]" aria-hidden="true">
          receipt_long
        </span>
        ดูบิล
      </button>
      {state.room.status === "vacant" && (
        <button
          type="button"
          role="menuitem"
          className="row-menu-item"
          onClick={() => {
            run(() => {
              window.location.hash = "#tenants";
            });
          }}
        >
          <span className="ms text-[1.125rem]" aria-hidden="true">
            person_add
          </span>
          เพิ่มผู้เช่า
        </button>
      )}
    </div>
  );
}

interface RoomDrawerProps {
  open: boolean;
  seedKey: string;
  base: Room | null;
  form: RoomForm;
  defaults: RateDefaults;
  dormCharges: DormCharge[];
  duplicateId: boolean;
  saving: boolean;
  serverError: { message: string; field?: string } | null;
  onChange: (form: RoomForm) => void;
  onClose: () => void;
  onSave: (input: RoomInput) => void;
}

function RoomDrawer({
  open,
  seedKey,
  base,
  form,
  defaults,
  dormCharges,
  duplicateId,
  saving,
  serverError,
  onChange,
  onClose,
  onSave,
}: RoomDrawerProps) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [seededKey, setSeededKey] = useState<string | null>(null);

  if (!open) {
    if (seededKey !== null) {
      setSeededKey(null);
    }
  } else if (seededKey !== seedKey) {
    setSeededKey(seedKey);
    setTouched({});
  }

  const touchedError = (
    field: string,
    message: string | undefined,
  ): string | undefined => (touched[field] === true ? message : undefined);

  const touch = (field: string) => {
    setTouched((previous) =>
      previous[field] === true ? previous : { ...previous, [field]: true },
    );
  };

  const rent = numericValue(form.rent);
  const rentInvalid = rent === null || !Number.isInteger(rent) || rent < 0;
  const waterMeterValue = numericValue(form.waterMeterInit);
  const waterMeterInvalid = waterMeterValue === null || waterMeterValue < 0;
  const electricMeterValue = numericValue(form.electricMeterInit);
  const electricMeterInvalid =
    electricMeterValue === null || electricMeterValue < 0;
  const customWater = numericValue(form.waterRate);
  const customWaterInvalid =
    form.waterMode === "custom" && (customWater === null || customWater <= 0);
  const customElectric = numericValue(form.electricRate);
  const customElectricInvalid =
    form.electricChoice === "custom" &&
    (customElectric === null || customElectric <= 0);
  const chargeInvalid = form.ownCharges.some(
    (charge) =>
      !isEmptyDraft(charge) &&
      (charge.name.trim() === "" || parseChargeAmount(charge.amount) === null),
  );

  const idBlank = form.id.trim() === "";
  const canSave =
    !idBlank &&
    !duplicateId &&
    !rentInvalid &&
    !waterMeterInvalid &&
    !electricMeterInvalid &&
    !customWaterInvalid &&
    !customElectricInvalid &&
    !chargeInvalid &&
    !saving;

  const fieldError = (name: string): string | undefined =>
    serverError !== null && serverError.field === name
      ? serverError.message
      : undefined;

  const update = (patch: Partial<RoomForm>) => {
    onChange({ ...form, ...patch });
  };

  const appendCharge = () => {
    update({ ownCharges: [...form.ownCharges, newChargeDraft()] });
  };

  const removeCharge = (chargeId: string) => {
    update({
      ownCharges: form.ownCharges.filter((charge) => charge.id !== chargeId),
    });
  };

  const editCharge = (
    chargeId: string,
    patch: Partial<Pick<ChargeDraft, "name" | "amount">>,
  ) => {
    update({
      ownCharges: form.ownCharges.map((charge) =>
        charge.id === chargeId ? { ...charge, ...patch } : charge,
      ),
    });
  };

  const toggleDormCharge = (dormChargeId: string) => {
    const excluded = form.excludedDormChargeIds.includes(dormChargeId);
    update({
      excludedDormChargeIds: excluded
        ? form.excludedDormChargeIds.filter((id) => id !== dormChargeId)
        : [...form.excludedDormChargeIds, dormChargeId],
    });
  };

  const save = () => {
    const input: RoomInput = {
      roomNumber: form.id.trim().toUpperCase(),
      rent: rent ?? 0,
      waterRate: form.waterMode === "custom" ? customWater : null,
      electricMode: form.electricChoice === "flat" ? "flat" : "meter",
      electricRate: form.electricChoice === "custom" ? customElectric : null,
      waterMeterInit: waterMeterValue ?? 0,
      electricMeterInit: electricMeterValue ?? 0,
      excludedDormChargeIds: form.excludedDormChargeIds,
      ownCharges: form.ownCharges
        .filter((charge) => !isEmptyDraft(charge))
        .map((charge) => ({
          name: charge.name.trim(),
          amount: parseChargeAmount(charge.amount) ?? 0,
        })),
    };

    onSave(input);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={base === null ? "เพิ่มห้อง" : `แก้ไขห้อง ${base.roomNumber}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button
            variant="primary"
            icon="save"
            disabled={!canSave}
            onClick={save}
          >
            บันทึกห้อง
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div
          onBlur={() => {
            touch("id");
          }}
        >
          <Field
            label="เลขห้อง"
            value={form.id}
            onChange={(value) => {
              update({ id: value });
            }}
            placeholder="เช่น A105"
            error={
              fieldError("roomNumber") ??
              touchedError(
                "id",
                idBlank
                  ? "กรอกเลขห้อง"
                  : duplicateId
                    ? "เลขห้องนี้ถูกใช้แล้ว"
                    : undefined,
              )
            }
          />
        </div>

        <div
          onBlur={() => {
            touch("rent");
          }}
        >
          <Field
            label="ค่าเช่า / เดือน (บาท)"
            value={form.rent}
            onChange={(value) => {
              update({ rent: value });
            }}
            inputMode="numeric"
            error={
              fieldError("rent") ??
              touchedError(
                "rent",
                rentInvalid ? "กรอกจำนวนเงินเป็นตัวเลข" : undefined,
              )
            }
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div
            onBlur={() => {
              touch("waterMeterInit");
            }}
          >
            <Field
              label="มิเตอร์น้ำเริ่มต้น"
              value={form.waterMeterInit}
              onChange={(value) => {
                update({ waterMeterInit: value });
              }}
              inputMode="numeric"
              error={
                fieldError("waterMeterInit") ??
                touchedError(
                  "waterMeterInit",
                  waterMeterInvalid ? "กรอกตัวเลข" : undefined,
                )
              }
            />
          </div>
          <div
            onBlur={() => {
              touch("electricMeterInit");
            }}
          >
            <Field
              label="มิเตอร์ไฟเริ่มต้น"
              value={form.electricMeterInit}
              onChange={(value) => {
                update({ electricMeterInit: value });
              }}
              inputMode="numeric"
              error={
                fieldError("electricMeterInit") ??
                touchedError(
                  "electricMeterInit",
                  electricMeterInvalid ? "กรอกตัวเลข" : undefined,
                )
              }
            />
          </div>
        </div>

        <fieldset className="grid gap-2">
          <legend className="field-label">ค่าน้ำ</legend>
          <ChoiceRow
            name="room-water"
            checked={form.waterMode === "default"}
            title="ใช้อัตราทั้งหอ"
            helper={`ใช้อัตราทั้งหอ ${defaults.waterRate} บาท/หน่วย`}
            onSelect={() => {
              update({ waterMode: "default" });
            }}
          />
          <ChoiceRow
            name="room-water"
            checked={form.waterMode === "custom"}
            title="กำหนดเอง"
            helper={`ห้องนี้คิดค่าน้ำเอง เริ่มจากอัตราทั้งหอ ${defaults.waterRate} บาท/หน่วย`}
            onSelect={() => {
              update({ waterMode: "custom" });
            }}
          />
          {form.waterMode === "custom" && (
            <div
              className="pl-7"
              onBlur={() => {
                touch("waterRate");
              }}
            >
              <Field
                label="อัตราค่าน้ำต่อหน่วย (บาท)"
                value={form.waterRate}
                onChange={(value) => {
                  update({ waterRate: value });
                }}
                inputMode="numeric"
                error={
                  fieldError("waterRate") ??
                  touchedError(
                    "waterRate",
                    customWaterInvalid ? "กรอกอัตราที่มากกว่า 0" : undefined,
                  )
                }
              />
            </div>
          )}
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="field-label">ค่าไฟ</legend>
          <ChoiceRow
            name="room-electric"
            checked={form.electricChoice === "default"}
            title="ใช้อัตราทั้งหอ"
            helper={`ใช้อัตราทั้งหอ ${defaults.electricRate} บาท/หน่วย`}
            onSelect={() => {
              update({ electricChoice: "default" });
            }}
          />
          <ChoiceRow
            name="room-electric"
            checked={form.electricChoice === "custom"}
            title="กำหนดเอง"
            helper="คิดตามหน่วยที่ใช้ ด้วยอัตราของห้องนี้"
            onSelect={() => {
              update({ electricChoice: "custom" });
            }}
          />
          <ChoiceRow
            name="room-electric"
            checked={form.electricChoice === "flat"}
            title="เหมาจ่ายรายเดือน"
            helper="เก็บค่าไฟเป็นยอดคงที่ทุกเดือน ไม่อ่านมิเตอร์"
            onSelect={() => {
              update({ electricChoice: "flat" });
            }}
          />
          {form.electricChoice === "custom" && (
            <div
              className="pl-7"
              onBlur={() => {
                touch("electricRate");
              }}
            >
              <Field
                label="อัตราค่าไฟต่อหน่วย (บาท)"
                value={form.electricRate}
                onChange={(value) => {
                  update({ electricRate: value });
                }}
                inputMode="numeric"
                error={
                  fieldError("electricRate") ??
                  touchedError(
                    "electricRate",
                    customElectricInvalid ? "กรอกอัตราที่มากกว่า 0" : undefined,
                  )
                }
              />
            </div>
          )}
          {form.electricChoice === "flat" && (
            <p className="pl-7 text-xs text-fog">
              โหมดเหมาจ่ายไม่ใช้อัตราต่อหน่วย จะกรอกยอดค่าไฟเต็มตอนสร้างบิล
            </p>
          )}
          {fieldError("electricMode") !== undefined && (
            <p className="text-xs text-danger">{fieldError("electricMode")}</p>
          )}
        </fieldset>

        {form.electricChoice === "flat" && (
          <fieldset className="grid gap-2">
            <legend className="field-label">การเชื่อมต่อ PEA</legend>
            <p className="text-xs text-fog">
              ใช้ดึงยอดบิลค่าไฟล่าสุดมาใส่ตอนสร้างบิลหรือ Statement ห้องว่าง
              บันทึกทันทีเมื่อกดบันทึกการเชื่อมต่อ ไม่ต้องรอปุ่มบันทึกห้อง
            </p>
            {base === null ? (
              <p className="text-xs text-fog">
                บันทึกห้องก่อน แล้วกลับมาตั้งการเชื่อมต่อ PEA ได้ที่นี่
              </p>
            ) : base.electricMode !== "flat" ? (
              <p className="text-xs text-fog">
                ห้องนี้ยังเป็นโหมดมิเตอร์ บันทึกห้องเป็นเหมาจ่ายก่อน
                แล้วกลับมาตั้งการเชื่อมต่อ PEA ได้ที่นี่
              </p>
            ) : (
              <RoomPeaConnection roomId={base.id} />
            )}
          </fieldset>
        )}

        <fieldset className="grid gap-2">
          <legend className="field-label">ค่าใช้จ่ายเพิ่มเติม</legend>
          <p className="text-xs text-fog">
            ค่าใช้จ่ายประจำของหอ
            เก็บกับทุกห้องและระบบเติมให้อัตโนมัติตอนสร้างบิล ปิดรายห้องได้ที่นี่
          </p>

          {dormCharges.length === 0 ? (
            <p className="text-xs text-fog">
              ยังไม่มีค่าใช้จ่ายของหอ เพิ่มได้ที่หน้าตั้งค่า
            </p>
          ) : (
            <ul className="grid gap-2">
              {dormCharges.map((charge) => {
                const off = form.excludedDormChargeIds.includes(charge.id);

                return (
                  <li
                    key={charge.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-ash px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm text-charcoal">
                        {charge.name}
                      </span>
                      <span className="num block text-xs text-fog">{`${baht(charge.amount)} บาท · จากค่าใช้จ่ายของหอ`}</span>
                    </span>
                    <label className="flex min-h-11 shrink-0 items-center gap-2 text-xs text-steel">
                      <input
                        type="checkbox"
                        className="h-4 w-4 shrink-0 accent-midnight-ink"
                        aria-label={`${off ? "ไม่เก็บ" : "เก็บ"} ${charge.name}`}
                        checked={!off}
                        onChange={() => {
                          toggleDormCharge(charge.id);
                        }}
                      />
                      {off ? "ไม่เก็บ" : "เก็บ"}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {fieldError("excludedDormChargeIds") !== undefined && (
            <p className="text-xs text-danger">
              {fieldError("excludedDormChargeIds")}
            </p>
          )}

          <p className="mt-2 text-xs text-fog">ค่าใช้จ่ายเฉพาะห้องนี้</p>
          {form.ownCharges.length > 0 && (
            <div className="flex items-end gap-2" aria-hidden="true">
              <span className="field-label min-w-0 flex-1">ชื่อรายการ</span>
              <span className="field-label w-20 shrink-0 text-right">
                จำนวนเงิน
              </span>
              <span className="w-11 shrink-0 md:w-[38px]" />
            </div>
          )}
          {form.ownCharges.map((charge, index) => {
            const showCharges = touched.charges === true;
            const nameInvalid =
              showCharges && !isEmptyDraft(charge) && charge.name.trim() === "";
            const amountInvalid =
              showCharges &&
              !isEmptyDraft(charge) &&
              parseChargeAmount(charge.amount) === null;

            return (
              <div key={charge.id} className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <input
                    type="text"
                    aria-label={`ชื่อรายการ ${index + 1}`}
                    className={`input-inline w-full text-left${nameInvalid ? " border-danger" : ""}`}
                    value={charge.name}
                    aria-invalid={nameInvalid}
                    aria-describedby={chargeInvalid ? "room-charges-error" : undefined}
                    onChange={(event) => {
                      editCharge(charge.id, { name: event.target.value });
                    }}
                    onBlur={() => {
                      touch("charges");
                    }}
                  />
                </div>
                <div className="w-20 shrink-0">
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label={`จำนวนเงิน ${index + 1}`}
                    className={`input-inline num w-full${amountInvalid ? " border-danger" : ""}`}
                    value={charge.amount}
                    aria-invalid={amountInvalid}
                    aria-describedby={chargeInvalid ? "room-charges-error" : undefined}
                    onChange={(event) => {
                      editCharge(charge.id, { amount: event.target.value });
                    }}
                    onBlur={() => {
                      touch("charges");
                    }}
                  />
                </div>
                <IconButton
                  icon="delete"
                  label={`ลบรายการที่ ${index + 1}`}
                  onClick={() => {
                    removeCharge(charge.id);
                  }}
                />
              </div>
            );
          })}
          <Button variant="ghost" size="sm" icon="add" onClick={appendCharge}>
            เพิ่มรายการเฉพาะห้อง
          </Button>
          {touched.charges === true && chargeInvalid && (
            <p id="room-charges-error" className="text-xs text-danger">
              ค่าใช้จ่ายเฉพาะห้องต้องมีชื่อและจำนวนเงินเป็นจำนวนเต็มไม่ติดลบ
            </p>
          )}
          {fieldError("ownCharges") !== undefined && (
            <p className="text-xs text-danger">{fieldError("ownCharges")}</p>
          )}
          {fieldError("charges") !== undefined && (
            <p className="text-xs text-danger">{fieldError("charges")}</p>
          )}
        </fieldset>

        {serverError !== null && serverError.field === undefined && (
          <p className="text-xs text-danger">{serverError.message}</p>
        )}
      </div>
    </Drawer>
  );
}

export function RoomsPage() {
  const { query, setQuery } = useSearch();
  const [roomList, setRoomList] = useState<Room[]>([]);
  const [tenantList, setTenantList] = useState<Tenant[]>([]);
  const [rateDefaults, setRateDefaults] = useState<RateDefaults | null>(null);
  const [dormCharges, setDormCharges] = useState<DormCharge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [view, setView] = useState<RoomView>(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(min-width: 768px)").matches
      ? "table"
      : "cards",
  );
  const [wideViewport, setWideViewport] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 768px)").matches,
  );
  const [period, setPeriod] = useState<string | null>(null);
  const [menu, setMenu] = useState<RoomMenuState | null>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const [form, setForm] = useState<RoomForm>(() =>
    emptyRoomForm({ waterRate: 0, electricRate: 0 }),
  );
  const [base, setBase] = useState<Room | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<{
    message: string;
    field?: string;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [list, settings, tenants, charges] = await Promise.all([
        fetchRooms(),
        fetchSettings(),
        fetchTenants().catch(() => [] as Tenant[]),
        fetchDormCharges().catch(() => [] as DormCharge[]),
      ]);
      setRoomList(list);
      setRateDefaults({
        waterRate: settings.defaultWaterRate,
        electricRate: settings.defaultElectricRate,
      });
      setTenantList(tenants);
      setDormCharges(charges);
      setPeriod(
        (current) => current ?? newestBilledPeriod(list) ?? periodAt(0),
      );
    } catch (loadError) {
      setError(
        loadError instanceof ApiError
          ? loadError.message
          : "โหลดข้อมูลห้องไม่สำเร็จ",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");

    const onMediaChange = (event: MediaQueryListEvent) => {
      setWideViewport(event.matches);
    };

    media.addEventListener("change", onMediaChange);

    return () => {
      media.removeEventListener("change", onMediaChange);
    };
  }, []);

  useEffect(() => {
    if (!wideViewport) {
      setView("cards");
    }
  }, [wideViewport]);

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

  const total = roomList.length;
  const occupiedCount = roomList.filter(
    (room) => room.status === "occupied",
  ).length;
  const vacantCount = total - occupiedCount;

  const needle = query.trim().toLowerCase();
  const needleDigits = needle.replace(/\D/g, "");
  const phoneByRoomId = new Map<string, string>();

  for (const tenant of tenantList) {
    if (tenant.status === "current") {
      phoneByRoomId.set(tenant.roomId, tenant.phone);
    }
  }

  const filtered = roomList.filter((room) => {
    const phone = phoneByRoomId.get(room.id) ?? "";
    const matchesQuery =
      needle === "" ||
      room.roomNumber.toLowerCase().includes(needle) ||
      (room.occupiedBy !== null &&
        room.occupiedBy.toLowerCase().includes(needle)) ||
      (phone !== "" &&
        (phone.includes(needle) ||
          (needleDigits !== "" &&
            phone.replace(/\D/g, "").includes(needleDigits))));
    const matchesStatus =
      statusFilter === "all"
        ? true
        : statusFilter === "occupied"
          ? room.status === "occupied"
          : room.status === "vacant";
    return matchesQuery && matchesStatus;
  });

  const duplicateId = roomList.some(
    (room) =>
      room.roomNumber === form.id.trim().toUpperCase() && room.id !== base?.id,
  );
  const defaults = rateDefaults ?? { waterRate: 0, electricRate: 0 };

  const billedPeriods = roomList
    .map((room) => room.lastElectricPeriod)
    .filter((value): value is string => value !== null);
  const periodOptions = Array.from(
    new Set([...recentPeriods(6), ...billedPeriods]),
  )
    .sort()
    .reverse();
  const filtering = needle !== "" || statusFilter !== "all";
  const loaded = !loading && error === null;
  const supporting = loading
    ? "กำลังโหลดข้อมูลห้อง"
    : error !== null
      ? undefined
      : filtering
        ? `แสดง ${filtered.length} จาก ${total} ห้อง · ทั้งหอมีผู้เช่า ${occupiedCount} · ว่าง ${vacantCount}`
        : `${total} ห้อง · มีผู้เช่า ${occupiedCount} · ว่าง ${vacantCount}`;
  const visibleAnnouncement =
    loaded && filtering ? `แสดง ${filtered.length} จาก ${total} ห้อง` : "";
  const rateOverrideCount = roomList.filter(
    (room) =>
      room.waterRate !== null ||
      (room.electricMode === "meter" && room.electricRate !== null),
  ).length;
  const rosterParts: string[] = [];

  if (period !== null) {
    rosterParts.push(`บิลรอบนี้คือ ${periodLabel(period)}`);
  }

  if (rateOverrideCount > 0) {
    rosterParts.push(
      "ห้องที่ตั้งราคาเองมีป้าย อัตราพิเศษ · ห้องที่ไม่มีป้ายใช้อัตราทั้งหอ",
    );
  }

  const rosterNote = rosterParts.join(" · ");

  const closeMenu = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) {
      menuTrigger.current?.focus();
    }

    setMenu(null);
  }, []);

  const openMenu = (room: Room, trigger: HTMLElement) => {
    if (menu !== null && menu.room.id === room.id) {
      closeMenu(true);
      return;
    }

    const rect = trigger.getBoundingClientRect();
    menuTrigger.current = trigger;
    // ความสูงสูงสุดของเมนู: 3 รายการ (แก้ไข/ดูบิล/เพิ่มผู้เช่า) × 44px + padding/gap ของ .row-menu
    const menuHeight = 3 * 44 + 16;
    const below = rect.bottom + 6;
    // เปิดลงแล้วไม่พอที่ให้พลิกไปเปิดเหนือปุ่ม — ไม่งั้นรายการท้ายเมนูหลุดขอบล่างบนมือถือ
    const top =
      below + menuHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - menuHeight - 6)
        : below;
    setMenu({
      room,
      trigger,
      top,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  };

  const openAdd = () => {
    setBase(null);
    setForm(emptyRoomForm(defaults));
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (room: Room) => {
    setBase(room);
    setForm(roomFormOf(room, defaults));
    setFormError(null);
    setFormOpen(true);
  };

  const saveRoom = async (input: RoomInput) => {
    setSaving(true);
    setFormError(null);

    try {
      if (base === null) {
        const created = await createRoom(input);
        showToast(`เพิ่มห้อง ${created.roomNumber} แล้ว`);
      } else {
        const updated = await updateRoom(base.id, input);
        showToast(`บันทึกห้อง ${updated.roomNumber} แล้ว`);
      }

      setFormOpen(false);
      setBase(null);
      await load();
    } catch (saveError) {
      if (saveError instanceof ApiError) {
        setFormError(
          saveError.field === undefined
            ? { message: saveError.message }
            : { message: saveError.message, field: saveError.field },
        );
      } else {
        setFormError({ message: "บันทึกข้อมูลห้องไม่สำเร็จ" });
      }
    } finally {
      setSaving(false);
    }
  };

  const columns: DataTableColumn<Room>[] = [
    {
      key: "room",
      header: "ห้อง",
      render: (room) => (
        <span className="num font-medium text-charcoal">{room.roomNumber}</span>
      ),
    },
    {
      key: "status",
      header: "สถานะ",
      render: (room) => <RoomStatusBadge room={room} />,
    },
    {
      key: "tenant",
      header: "ผู้เช่า",
      render: (room) =>
        room.occupiedBy === null ? (
          <span className="text-fog">ยังไม่มีผู้เช่า</span>
        ) : (
          <span className="text-charcoal">{room.occupiedBy}</span>
        ),
    },
    {
      key: "rent",
      header: "ค่าเช่า",
      align: "right",
      render: (room) => (
        <RoomMoney room={room} label="ค่าเช่า">
          <span className="whitespace-nowrap">{moneyText(room.rent)}</span>
        </RoomMoney>
      ),
    },
    {
      key: "water",
      header: "ค่าน้ำ",
      align: "right",
      render: (room) => (
        <div className="flex items-center justify-end gap-2">
          <RoomMoney room={room} label="ค่าน้ำ">
            <span className={rateTextClass(waterInherited(room), true)}>
              {waterRateText(room, defaults)}
            </span>
          </RoomMoney>
          {room.waterRate !== null && <span className="chip">อัตราพิเศษ</span>}
        </div>
      ),
    },
    {
      key: "electric",
      header: "ค่าไฟ",
      align: "right",
      render: (room) =>
        room.electricMode === "flat" ? (
          <RoomMoney room={room} label="ค่าไฟ">
            <span className="chip">ไฟเหมา</span>
          </RoomMoney>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <RoomMoney room={room} label="ค่าไฟ">
              <span className={rateTextClass(electricInherited(room), true)}>
                {electricText(room, defaults)}
              </span>
            </RoomMoney>
            {room.electricRate !== null && (
              <span className="chip">อัตราพิเศษ</span>
            )}
          </div>
        ),
    },
    {
      key: "recurring",
      header: "ค่าประจำ",
      align: "right",
      render: (room) =>
        room.charges.length === 0 ? null : (
          <div className="flex justify-end">
            <RecurringCharges room={room} align="right" />
          </div>
        ),
    },
    {
      key: "action",
      header: "จัดการ",
      align: "right",
      render: (room) => (
        <div className="flex justify-end">
          <IconButton
            icon="more_vert"
            label={`เปิดเมนูจัดการห้อง ${room.roomNumber}`}
            aria-haspopup="menu"
            aria-expanded={menu?.room.id === room.id}
            onClick={(event) => {
              openMenu(room, event.currentTarget);
            }}
          />
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="ห้องพัก"
        supporting={supporting}
        actions={
          <Button variant="primary" icon="add" onClick={openAdd}>
            เพิ่มห้อง
          </Button>
        }
      />

      <p className="sr-only" role="status" aria-live="polite">
        {visibleAnnouncement}
      </p>

      {error === null && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-60 md:hidden">
              <Field
                label="ค้นหาห้อง ผู้เช่า หรือเบอร์โทร"
                value={query}
                onChange={setQuery}
                placeholder="เช่น A105 หรือ สมชาย"
                helper="จับคู่เลขห้อง ชื่อผู้เช่า และเบอร์โทร"
              />
            </div>
            {period !== null && (
              <div className="w-full sm:w-48">
                <Select
                  label="รอบบิล"
                  value={period}
                  onChange={(value) => {
                    setPeriod(value);
                  }}
                  options={periodOptions.map((option) => ({
                    value: option,
                    label: periodLabel(option),
                  }))}
                />
              </div>
            )}
            <div className="w-full sm:w-40">
              <Select
                label="สถานะ"
                value={statusFilter}
                onChange={(value) => {
                  if (
                    value === "all" ||
                    value === "occupied" ||
                    value === "vacant"
                  ) {
                    setStatusFilter(value);
                  }
                }}
                options={[
                  { value: "all", label: "ทั้งหมด" },
                  { value: "occupied", label: "มีผู้เช่า" },
                  { value: "vacant", label: "ว่าง" },
                ]}
              />
            </div>
            <div className="w-full sm:w-auto">
              <span className="field-label" id="rooms-view-label">
                มุมมอง
              </span>
              <div
                className="flex gap-1 rounded-lg border border-ash p-1"
                role="group"
                aria-labelledby="rooms-view-label"
              >
                <button
                  type="button"
                  aria-pressed={wideViewport && view === "table"}
                  aria-disabled={!wideViewport}
                  aria-label={
                    wideViewport
                      ? undefined
                      : "ตาราง ใช้ได้บนหน้าจอใหญ่เท่านั้น"
                  }
                  className={`btn ${!wideViewport ? "cursor-not-allowed text-silver" : view === "table" ? "bg-paper-mist text-charcoal" : "text-steel"}`}
                  onClick={() => {
                    if (wideViewport) {
                      setView("table");
                    }
                  }}
                >
                  <span className="ms text-[1.125rem]" aria-hidden="true">
                    table_rows
                  </span>
                  ตาราง
                </button>
                <button
                  type="button"
                  aria-pressed={view === "cards"}
                  className={`btn ${view === "cards" ? "bg-paper-mist text-charcoal" : "text-steel"}`}
                  onClick={() => {
                    setView("cards");
                  }}
                >
                  <span className="ms text-[1.125rem]" aria-hidden="true">
                    grid_view
                  </span>
                  การ์ด
                </button>
              </div>
            </div>
            <p className="hidden text-xs text-fog md:block md:pb-3">
              ช่องค้นหาด้านบนของหน้านี้จับคู่เลขห้อง ชื่อผู้เช่า และเบอร์โทร
            </p>
            {/* จอเล็กปุ่ม "ตาราง" กดไม่ได้ (aria-disabled) — บอกเหตุผลให้คนที่เห็นปุ่มจาง ๆ รู้
                เพราะ aria-label ช่วยได้เฉพาะโปรแกรมอ่านหน้าจอ และ title ไม่แสดงบนจอสัมผัส */}
            <p className="mt-1.5 text-xs text-fog md:hidden">
              มุมมองตารางใช้ได้บนหน้าจอใหญ่เท่านั้น
            </p>
          </div>
        </Card>
      )}

      {loading ? (
        <Card>
          <div className="grid gap-3" aria-busy="true">
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        </Card>
      ) : error !== null ? (
        <Card>
          <EmptyState
            icon="cloud_off"
            title="โหลดข้อมูลห้องไม่สำเร็จ"
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
      ) : filtered.length === 0 ? (
        total === 0 ? (
          <Card>
            <EmptyState
              icon="door_front"
              title="ยังไม่มีห้องพัก"
              description="เพิ่มห้องแรกเพื่อตั้งค่าเช่า อัตราน้ำไฟ และติดตามสถานะผู้เช่าในที่เดียว"
              action={
                <Button variant="primary" icon="add" onClick={openAdd}>
                  เพิ่มห้องแรก
                </Button>
              }
            />
          </Card>
        ) : (
          <Card>
            <EmptyState
              icon="search_off"
              title="ไม่พบห้องที่ตรงกับเงื่อนไข"
              description="ลองล้างคำค้นหาหรือตัวกรองสถานะเพื่อดูห้องทั้งหมด"
              action={
                <Button
                  variant="secondary"
                  icon="filter_alt_off"
                  onClick={() => {
                    setStatusFilter("all");
                    setQuery("");
                  }}
                >
                  ล้างตัวกรอง
                </Button>
              }
            />
          </Card>
        )
      ) : view === "table" && wideViewport ? (
        <>
          {rosterNote !== "" && (
            <p className="mb-2 text-xs text-fog">{rosterNote}</p>
          )}
          <Card>
            <figure>
              <figcaption id="rooms-table-caption" className="sr-only">
                ตารางห้องพัก แต่ละแถวคือหนึ่งห้อง พร้อมสถานะบิลของรอบบิล ค่าเช่า
                ค่าน้ำ ค่าไฟ และค่าใช้จ่ายประจำ
              </figcaption>
              <DataTable
                columns={columns}
                rows={filtered}
                getRowKey={(room) => room.id}
                minWidth={1040}
              />
            </figure>
          </Card>
        </>
      ) : (
        <>
          {rosterNote !== "" && (
            <p className="mb-2 text-xs text-fog">{rosterNote}</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((room) => (
              <Card key={room.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="num block text-base font-medium text-charcoal">
                      {room.roomNumber}
                    </span>
                    <span className="block text-xs text-fog">
                      {room.occupiedBy ?? "ยังไม่มีผู้เช่า"}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <RoomStatusBadge room={room} />
                    <IconButton
                      icon="more_vert"
                      label={`เปิดเมนูจัดการห้อง ${room.roomNumber}`}
                      aria-haspopup="menu"
                      aria-expanded={menu?.room.id === room.id}
                      onClick={(event) => {
                        openMenu(room, event.currentTarget);
                      }}
                    />
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-ash pt-3">
                  <div>
                    <dt className="text-xs text-fog">ค่าเช่า</dt>
                    <dd className="num text-sm text-charcoal">
                      {moneyText(room.rent)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-fog">ค่าน้ำ</dt>
                    <dd
                      className={`${rateTextClass(waterInherited(room), true)} text-sm`}
                    >
                      {waterRateText(room, defaults)}
                    </dd>
                    {room.waterRate !== null && (
                      <span className="chip mt-1">อัตราพิเศษ</span>
                    )}
                  </div>
                  <div>
                    <dt className="text-xs text-fog">ค่าไฟ</dt>
                    <dd className="text-sm">
                      {room.electricMode === "flat" ? (
                        <span className="chip">ไฟเหมา</span>
                      ) : (
                        <span
                          className={rateTextClass(
                            electricInherited(room),
                            true,
                          )}
                        >
                          {electricText(room, defaults)}
                        </span>
                      )}
                    </dd>
                    {room.electricMode === "meter" &&
                      room.electricRate !== null && (
                        <span className="chip mt-1">อัตราพิเศษ</span>
                      )}
                  </div>
                  {room.charges.length > 0 && (
                    <div>
                      <dt className="text-xs text-fog">ค่าประจำ</dt>
                      <dd>
                        <RecurringCharges room={room} />
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-xs text-fog">มิเตอร์เริ่มต้น</dt>
                    <dd className="num text-sm text-charcoal">
                      {meterText(room)}
                    </dd>
                  </div>
                </dl>
              </Card>
            ))}
          </div>
        </>
      )}

      {menu !== null && (
        <RoomMenu
          state={menu}
          period={period}
          onClose={closeMenu}
          onEdit={openEdit}
        />
      )}

      <RoomDrawer
        open={formOpen}
        seedKey={base === null ? "add" : base.id}
        base={base}
        form={form}
        defaults={defaults}
        dormCharges={dormCharges}
        duplicateId={duplicateId}
        saving={saving}
        serverError={formError}
        onChange={setForm}
        onClose={() => {
          setFormOpen(false);
          setBase(null);
          setFormError(null);
        }}
        onSave={(input) => {
          void saveRoom(input);
        }}
      />

      <Toast message={toast ?? ""} open={toast !== null} />
    </div>
  );
}
