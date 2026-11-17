// SPDX-License-Identifier: AGPL-3.0-only
// Text and value fields: Astryx's (ADR 0020), taking the props a native <input> or <textarea> takes, so
// screens pass a string value, read `e.target.value` in onChange, and name a field for FormData. The
// type picks the Astryx field: TextInput, NumberInput, DateInput, TimeInput, DateTimeInput or FileInput.
// The label is `label` (Field passes its own), else `aria-label` as a hidden label. Before the shell,
// use NativeInput (components/native.tsx).
import { Children, createElement, isValidElement, lazy, Suspense, useEffect, useRef, useState, type ChangeEvent, type ComponentProps, type ComponentType, type ReactNode, type RefObject } from "react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Selector } from "@astryxdesign/core/Selector";
import { loadFields, loadedFields, type LaterFields } from "./laterSource";

// The number, date, time and file fields are most of this file's weight (about 72 kB gzipped of 88), so
// they load when a screen first shows one, behind a disabled text field of the same size; once loaded,
// one renders at once.
function later<K extends keyof LaterFields>(key: K) {
  type P = ComponentProps<LaterFields[K]>;
  const Lazy = lazy(async () => ({ default: (await loadFields())[key] as unknown as ComponentType<P> }));
  return (p: P) => createElement(((loadedFields()?.[key] as unknown) ?? Lazy) as ComponentType<object>, p as object);
}
const NumberInput = later("NumberInput");
const DateInput = later("DateInput");
const TimeInput = later("TimeInput");
const DateTimeInput = later("DateTimeInput");
const FileInput = later("FileInput");
import { textOf } from "./Button";

type Own = { label?: string; hint?: ReactNode };
type InputProps = Omit<ComponentProps<"input">, "size"> & Own;
type TextareaProps = ComponentProps<"textarea"> & Own;

const TEXT_TYPES = new Set(["text", "email", "url", "password", "search", "tel"]);

/** A change event for callers that read `e.target.value` (or `files`), when Astryx hands back a value. */
const changeOf = (value: string, name?: string, files?: FileList | File[] | null) =>
  ({ target: { value, name, files }, currentTarget: { value, name, files } }) as unknown as ChangeEvent<HTMLInputElement>;

/** The value a field shows: the caller's, or its own while the caller leaves it uncontrolled. An
    uncontrolled one goes back to its default when its form is reset, as a native field does. */
function useValue(value: unknown, defaultValue: unknown) {
  const initial = defaultValue === undefined ? "" : String(defaultValue);
  const [own, setOwn] = useState(initial);
  const controlled = value !== undefined;
  const anchor = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const form = anchor.current?.form;
    if (controlled || !form) return;
    const reset = () => setOwn(initial);
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [controlled, initial]);
  return [controlled ? String(value ?? "") : own, (next: string) => !controlled && setOwn(next), anchor] as const;
}

/** FormData reads a named field from a hidden input, whatever the Astryx field renders inside; the
    same input finds the form for a reset. */
const Named = (p: { name?: string; value: string; anchor: RefObject<HTMLInputElement | null> }) => <input ref={p.anchor} type="hidden" name={p.name} value={p.value} />;

export function Input({ type = "text", label, hint, value, defaultValue, onChange, name, "aria-label": ariaLabel, disabled, readOnly, required, placeholder, autoFocus, min, max, step, accept, multiple, className, ...rest }: InputProps) {
  const [current, setCurrent, anchor] = useValue(value, defaultValue);
  const [files, setFiles] = useState<File | File[] | null>(null);
  const text = label ?? ariaLabel ?? "";
  // `required` stays the native attribute: Astryx's isRequired would add "Required" to the label.
  // A width or margin class sizes the whole field; Astryx ignores className on its fields.
  const common = { label: text, isLabelHidden: !label, description: typeof hint === "string" ? hint : undefined, isDisabled: disabled, required, placeholder, containerClassName: className };
  const emit = (next: string) => {
    setCurrent(next);
    onChange?.(changeOf(next, name));
  };
  // Other native attributes (maxLength, pattern, autoComplete, id, ref, handlers) reach the inner input.
  const pass = rest as Record<string, unknown>;
  let field: ReactNode;
  if (type === "number")
    field = <NumberInput {...common} {...pass} isReadOnly={readOnly} hasAutoFocus={autoFocus} value={current === "" ? null : Number(current)} min={min === undefined ? undefined : Number(min)} max={max === undefined ? undefined : Number(max)} step={step === undefined || step === "any" ? undefined : Number(step)} onChange={(n) => emit(Number.isNaN(n) ? "" : String(n))} />;
  else if (type === "date") field = <DateInput {...common} {...pass} value={(current || undefined) as never} min={min as never} max={max as never} onChange={(v) => emit(v ?? "")} />;
  else if (type === "time") field = <TimeInput {...common} {...pass} value={(current || undefined) as never} min={min as never} max={max as never} onChange={(v) => emit(v ?? "")} />;
  else if (type === "datetime-local") field = <DateTimeInput {...common} {...pass} value={(current || undefined) as never} min={min as never} max={max as never} onChange={(v) => emit(v ?? "")} />;
  else if (type === "file") {
    field = (
      <FileInput
        {...common}
        {...pass}
        accept={accept}
        isMultiple={multiple}
        value={files}
        onChange={(f) => {
          setFiles(f);
          const list = f === null ? [] : Array.isArray(f) ? f : [f];
          onChange?.(changeOf("", name, list));
        }}
      />
    );
  }
  if (field) field = <Suspense fallback={<TextInput {...common} isDisabled value={current} onChange={() => {}} />}>{field}</Suspense>;
  else
    field = (
      <TextInput
        {...common}
        {...pass}
        type={(TEXT_TYPES.has(type) ? type : "text") as never}
        isReadOnly={readOnly}
        hasAutoFocus={autoFocus}
        value={current}
        onChange={(v, e) => {
          setCurrent(v);
          onChange?.(e);
        }}
      />
    );
  return (
    <>
      {field}
      {type !== "file" && <Named name={name} value={current} anchor={anchor} />}
    </>
  );
}

export function Textarea({ label, hint, value, defaultValue, onChange, name, "aria-label": ariaLabel, disabled, readOnly, required, placeholder, autoFocus, rows, maxLength, className, ...rest }: TextareaProps) {
  const [current, setCurrent, anchor] = useValue(value, defaultValue);
  return (
    <>
      <TextArea
        {...({ ...rest, required, containerClassName: className } as Record<string, unknown>)}
        label={label ?? ariaLabel ?? ""}
        isLabelHidden={!label}
        description={typeof hint === "string" ? hint : undefined}
        isDisabled={disabled}
        isReadOnly={readOnly}
        placeholder={placeholder}
        hasAutoFocus={autoFocus}
        rows={rows}
        maxLength={maxLength}
        value={current}
        onChange={(v, e) => {
          setCurrent(v);
          onChange?.(e);
        }}
      />
      <Named name={name} value={current} anchor={anchor} />
    </>
  );
}

type SelectProps = Omit<ComponentProps<"select">, "size"> & Own;
type Option = { value: string; label: string; disabled?: boolean };
type Section = { type: "section"; title?: string; options: Option[] };

/** A native select's <option> and <optgroup> children, as Astryx Selector options. */
function optionsOf(children: ReactNode): (Option | Section)[] {
  return Children.toArray(children).flatMap((c): (Option | Section)[] => {
    if (!isValidElement<{ value?: unknown; label?: string; disabled?: boolean; children?: ReactNode }>(c)) return [];
    if (c.type === "option") return [{ value: String(c.props.value ?? textOf(c.props.children)), label: textOf(c.props.children), disabled: c.props.disabled }];
    if (c.type === "optgroup") return [{ type: "section", title: c.props.label, options: optionsOf(c.props.children) as Option[] }];
    return optionsOf(c.props.children);
  });
}

/** Every time zone this browser knows, as IANA names, with the one already chosen kept even when the browser doesn't list it. */
export function timeZones(current: string): string[] {
  const all = Intl.supportedValuesOf("timeZone");
  return all.includes(current) ? all : [current, ...all];
}

/** A select: Astryx's Selector, taking a native <select>'s props and <option> children. Like a native
    one, an uncontrolled select starts on its first option. */
export function Select({ label, hint, value, defaultValue, onChange, name, "aria-label": ariaLabel, disabled, required, className, children, ...rest }: SelectProps) {
  const options = optionsOf(children);
  const first = options.flatMap((o) => ("options" in o ? o.options : [o]))[0]?.value;
  const [current, setCurrent, anchor] = useValue(value, defaultValue ?? first);
  return (
    <>
      <Selector
        {...({ ...rest, required, containerClassName: className } as Record<string, unknown>)}
        label={label ?? ariaLabel ?? ""}
        isLabelHidden={!label}
        description={typeof hint === "string" ? hint : undefined}
        isDisabled={disabled}
        options={options}
        value={current}
        onChange={(v) => {
          setCurrent(v);
          onChange?.(changeOf(v, name) as unknown as ChangeEvent<HTMLSelectElement>);
        }}
      />
      <Named name={name} value={current} anchor={anchor} />
    </>
  );
}

// Field (components/layout.tsx) hands its label to these, and finds them by this mark rather than by
// importing them, so layout stays out of the first page's bundle.
Object.assign(Input, { astryxField: true });
Object.assign(Textarea, { astryxField: true });
Object.assign(Select, { astryxField: true });
