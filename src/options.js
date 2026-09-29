import { getResolution, setResolution } from "./settings.js";

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
    saved.textContent = "保存しました。次の撮影から使います。";
  } catch (error) {
    console.error(error);
    saved.textContent = "保存できませんでした。もう一度選んでください。";
  } finally {
    saving = false;
  }
});
