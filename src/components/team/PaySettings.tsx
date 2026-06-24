"use client";

import { useState, useTransition } from "react";
import { Loader2, DollarSign, MapPin } from "lucide-react";
import { savePaySettings } from "@/app/team/actions";

type Props = {
  memberId: string;
  homeAddress: string | null;
  payPercent: number | null;
  payFloor: number | null;
  mileageRate: number;
  homeRadiusMi: number;
};

// Manually set a creative's pay rates. Drives the automatic payroll:
//   Shoot pay = max(eligible invoice × percent, floor); mileage beyond the radius.
export function PaySettings(props: Props) {
  const [homeAddress, setHomeAddress] = useState(props.homeAddress ?? "");
  const [percent, setPercent] = useState(props.payPercent != null ? String(Math.round(props.payPercent * 100)) : "");
  const [floor, setFloor] = useState(props.payFloor != null ? String(props.payFloor) : "");
  const [mileageRate, setMileageRate] = useState(String(props.mileageRate ?? 0.65));
  const [radius, setRadius] = useState(String(props.homeRadiusMi ?? 35));
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving, start] = useTransition();

  const save = () =>
    start(async () => {
      const r = await savePaySettings(props.memberId, {
        homeAddress: homeAddress.trim() || null,
        payPercent: percent.trim() ? Number(percent) / 100 : null,
        payFloor: floor.trim() ? Number(floor) : null,
        mileageRate: mileageRate.trim() ? Number(mileageRate) : 0.65,
        homeRadiusMi: radius.trim() ? Math.round(Number(radius)) : 35,
      });
      setNote({ ok: r.ok, msg: r.message });
    });

  return (
    <section className="rounded-2xl border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3">
        <DollarSign className="size-4 text-success" />
        <h2 className="text-sm font-semibold">Pay settings</h2>
      </div>
      <div className="space-y-3 px-5 py-4">
        <div>
          <label className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <MapPin className="size-3.5" /> Home address (mileage origin)
          </label>
          <input
            value={homeAddress}
            onChange={(e) => setHomeAddress(e.target.value)}
            placeholder="123 Main St, Town, PA"
            className="w-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-sm outline-none focus:border-brand"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Shoot pay %" suffix="%" value={percent} onChange={setPercent} placeholder="35" />
          <Field label="Minimum / shoot" prefix="$" value={floor} onChange={setFloor} placeholder="100" />
          <Field label="Mileage rate" prefix="$" value={mileageRate} onChange={setMileageRate} placeholder="0.65" />
          <Field label="Free radius" suffix="mi" value={radius} onChange={setRadius} placeholder="35" />
        </div>

        <p className="text-[11px] text-muted-2">
          Shoot pay = max(eligible invoice × {percent || "35"}%, ${floor || "100"}). Mileage pays $
          {mileageRate || "0.65"}/mi beyond {radius || "35"} mi each way (free miles/day = {(Number(radius) || 35) * 2}).
        </p>

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} Save
          </button>
          {note && <span className={`text-xs ${note.ok ? "text-success" : "text-danger"}`}>{note.msg}</span>}
        </div>
      </div>
    </section>
  );
}

function Field({
  label, value, onChange, placeholder, prefix, suffix,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; prefix?: string; suffix?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</label>
      <div className="flex items-center rounded-lg border border-border bg-surface-2 px-2.5 focus-within:border-brand">
        {prefix && <span className="text-sm text-muted-2">{prefix}</span>}
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode="decimal"
          className="w-full bg-transparent py-1.5 text-sm outline-none"
        />
        {suffix && <span className="text-sm text-muted-2">{suffix}</span>}
      </div>
    </div>
  );
}
