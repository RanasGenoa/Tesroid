import type { AppStore } from "../../../state/index.js";
import type { TouchPickerOption } from "../../touch-picker.js";
import type { SettingsPollingClock } from "./clock.js";

export const TWO_TAP_WINDOW_MS = 5_000;

export interface SettingsTabContext {
  readonly store: AppStore;
  readonly clock: SettingsPollingClock;
  rerender(): void;
}

export interface GeneralTabContext extends SettingsTabContext {
  openOptionPicker(
    doc: Document,
    testid: string,
    title: string,
    options: readonly TouchPickerOption[],
    selectedValue: string,
  ): Promise<string | null>;
}
