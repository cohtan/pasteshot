import { localize, t } from "./i18n.js";
import { getResolution, setResolution } from "./settings.js";

localize();

const form = document.querySelector("#form");
const saved = document.querySelector("#saved");
let saving = false;

const current = await getResolution();
const selected = form.querySelector(`input[value="${current.id}"]`);
if (selected) selected.checked = true;

form.addEventListener("change", async () => {
  const chosen = form.querySelector("input:checked");
  if (!chosen || saving) return;
  saving = true;
  try {
    await setResolution(chosen.value);
    saved.textContent = t("savedOk");
  } catch (error) {
    console.error(error);
    saved.textContent = t("saveFailed");
  } finally {
    saving = false;
  }
});
