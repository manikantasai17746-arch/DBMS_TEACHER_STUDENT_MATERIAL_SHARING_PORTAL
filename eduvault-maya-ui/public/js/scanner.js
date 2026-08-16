// ---------------------------------------------------------------------------
// EduVault ID Card Scanner
// ---------------------------------------------------------------------------
// Supports:
//   - Code 128  <-- your college ID card
//   - Code 39
//   - EAN-13
//   - EAN-8
//   - UPC-A
//   - UPC-E
//   - QR Code
//
// Example ID card barcode:
//   26B21CS073
//
// Scanner strategy:
//   1. Prefer ZXing because it gives us TRY_HARDER for difficult barcodes.
//   2. Request high-resolution rear camera.
//   3. Try continuous autofocus where the browser/device supports it.
//   4. Fall back to native BarcodeDetector if ZXing isn't available.
// ---------------------------------------------------------------------------

let __zxingReader = null;
let __scanModalEl = null;
let __detectorRAF = null;
let __mediaStream = null;
let __activeCancelFn = null;

const SCAN_FORMATS_NATIVE = [
  "code_128",
  "code_39",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "qr_code"
];

function buildScanModal() {

  if (__scanModalEl) {
    return __scanModalEl;
  }

  const modal = document.createElement("div");

  modal.id = "scanModal";

  modal.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(6, 12, 24, 0.82);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  `;

  // One-time keyframes / helper classes for the scanner's motion graphics.
  if (!document.getElementById("scanModalStyles")) {
    const styleTag = document.createElement("style");
    styleTag.id = "scanModalStyles";
    styleTag.textContent = `
      @keyframes scanSweep {
        0%   { top: 6%; opacity: 0; }
        10%  { opacity: 1; }
        90%  { opacity: 1; }
        100% { top: 92%; opacity: 0; }
      }
      @keyframes scanPulseRing {
        0%   { box-shadow: 0 0 0 0 rgba(2,195,154,0.45); }
        100% { box-shadow: 0 0 0 14px rgba(2,195,154,0); }
      }
      @keyframes scanFadeIn {
        from { opacity: 0; transform: translateY(10px) scale(0.98); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      .scan-sweep-line { animation: scanSweep 2.1s ease-in-out infinite; }
      .scan-modal-card { animation: scanFadeIn 0.22s ease-out; }
      .scan-status-dot { animation: scanPulseRing 1.6s ease-out infinite; }
      .scan-close-btn:hover { background: rgba(255,255,255,0.14) !important; }
      .scan-manual-btn:hover { background: rgba(2,128,144,0.08) !important; }
    `;
    document.head.appendChild(styleTag);
  }

  modal.innerHTML = `
    <div
      class="scan-modal-card"
      style="
        background: #10151d;
        border-radius: 20px;
        max-width: 480px;
        width: 100%;
        overflow: hidden;
        box-shadow: 0 25px 70px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06);
      "
    >
      <div
        style="
          padding: 1.15rem 1.3rem;
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: linear-gradient(135deg, #0B2F6B 0%, #1558C0 100%);
        "
      >
        <div style="display:flex; align-items:center; gap:0.6rem;">
          <span
            class="scan-status-dot"
            style="
              width: 9px; height: 9px; border-radius: 50%;
              background: #02C39A; display:inline-block; flex-shrink:0;
            "
          ></span>
          <strong
            style="
              font-family: 'Spartan', 'Poppins', sans-serif;
              color: #fff;
              font-size: 1.02rem;
              letter-spacing: -0.01em;
            "
          >
            Scan Your ID Card
          </strong>
        </div>

        <button
          id="scanCloseBtn"
          type="button"
          aria-label="Close scanner"
          class="scan-close-btn"
          style="
            background: rgba(255,255,255,0.08);
            border: none;
            width: 30px; height: 30px; border-radius: 50%;
            font-size: 1.3rem;
            cursor: pointer;
            color: #fff;
            line-height: 1;
            display: flex; align-items: center; justify-content: center;
            transition: background 0.15s ease;
          "
        >
          &times;
        </button>
      </div>

      <div
        style="
          position: relative;
          background: #000;
          width: 100%;
          aspect-ratio: 4 / 3;
          overflow: hidden;
        "
      >
        <video
          id="scanVideo"
          muted
          playsinline
          autoplay
          style="
            width: 100%;
            height: 100%;
            object-fit: contain;
            display: block;
            background: #000;
          "
        ></video>

        <!-- dark mask with a clear cut-out frame -->
        <div
          style="
            position: absolute; inset: 0;
            background: rgba(0,0,0,0.4);
            -webkit-mask: linear-gradient(#000 0 0);
            pointer-events: none;
          "
        ></div>
        <div
          style="
            position: absolute; left: 6%; right: 6%; top: 25%; height: 50%;
            box-shadow: 0 0 0 999px rgba(0,0,0,0.45);
            border-radius: 14px; pointer-events: none;
          "
        ></div>

        <!-- animated corner brackets -->
        <div style="position:absolute; left:6%; top:25%; width:50px; height:50px; pointer-events:none;">
          <div style="position:absolute; top:0; left:0; width:100%; height:4px; background:#02C39A; border-radius:3px; box-shadow:0 0 10px rgba(2,195,154,0.7);"></div>
          <div style="position:absolute; top:0; left:0; width:4px; height:100%; background:#02C39A; border-radius:3px; box-shadow:0 0 10px rgba(2,195,154,0.7);"></div>
        </div>
        <div style="position:absolute; right:6%; top:25%; width:50px; height:50px; pointer-events:none;">
          <div style="position:absolute; top:0; right:0; width:100%; height:4px; background:#02C39A; border-radius:3px; box-shadow:0 0 10px rgba(2,195,154,0.7);"></div>
          <div style="position:absolute; top:0; right:0; width:4px; height:100%; background:#02C39A; border-radius:3px; box-shadow:0 0 10px rgba(2,195,154,0.7);"></div>
        </div>
        <div style="position:absolute; left:6%; bottom:25%; width:50px; height:50px; pointer-events:none;">
          <div style="position:absolute; bottom:0; left:0; width:100%; height:4px; background:#02C39A; border-radius:3px; box-shadow:0 0 10px rgba(2,195,154,0.7);"></div>
          <div style="position:absolute; bottom:0; left:0; width:4px; height:100%; background:#02C39A; border-radius:3px; box-shadow:0 0 10px rgba(2,195,154,0.7);"></div>
        </div>
        <div style="position:absolute; right:6%; bottom:25%; width:50px; height:50px; pointer-events:none;">
          <div style="position:absolute; bottom:0; right:0; width:100%; height:4px; background:#02C39A; border-radius:3px; box-shadow:0 0 10px rgba(2,195,154,0.7);"></div>
          <div style="position:absolute; bottom:0; right:0; width:4px; height:100%; background:#02C39A; border-radius:3px; box-shadow:0 0 10px rgba(2,195,154,0.7);"></div>
        </div>

        <!-- sweeping laser line -->
        <div
          class="scan-sweep-line"
          style="
            position: absolute; left: 8%; right: 8%; top: 25%; height: 2px;
            background: linear-gradient(90deg, transparent, #02C39A 20%, #02C39A 80%, transparent);
            box-shadow: 0 0 10px rgba(2,195,154,0.9);
            pointer-events: none;
          "
        ></div>
      </div>

      <div
        style="
          padding: 1rem 1.3rem 1.3rem;
          background: #10151d;
        "
      >
        <p
          id="scanStatus"
          style="
            margin: 0 0 0.35rem;
            font-size: 0.87rem;
            line-height: 1.5;
            color: #C9D3DE;
          "
        >
          Place the barcode horizontally inside the frame.
        </p>

        <p
          style="
            margin: 0 0 1rem;
            font-size: 0.75rem;
            color: #7C8A9B;
          "
        >
          Move closer until the barcode bars are sharp and clearly visible.
        </p>

        <button
          id="scanManualBtn"
          type="button"
          class="scan-manual-btn"
          style="
            width: 100%;
            padding: 0.65rem;
            border-radius: 9px;
            border: 1px solid #2A3B52;
            background: transparent;
            color: #5CC8E0;
            font-weight: 600;
            font-size: 0.85rem;
            cursor: pointer;
            transition: background 0.15s ease;
          "
        >
          Can't scan? Enter code manually
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  __scanModalEl = modal;

  return modal;
}

function openIdCardScanner() {

  return new Promise((resolve, reject) => {

    if (__activeCancelFn) {
      try {
        __activeCancelFn();
      } catch (e) {
        console.warn("Previous scanner cleanup error:", e);
      }
      __activeCancelFn = null;
    }

    const modal = buildScanModal();

    const video = modal.querySelector("#scanVideo");
    const status = modal.querySelector("#scanStatus");
    const closeBtn = modal.querySelector("#scanCloseBtn");
    const manualBtn = modal.querySelector("#scanManualBtn");

    modal.style.display = "flex";

    status.textContent =
      "Starting camera... Place the barcode inside the frame.";

    status.style.color = "#C9D3DE";

    let settled = false;

    function cleanup() {

      if (__detectorRAF) {
        cancelAnimationFrame(__detectorRAF);
      }

      __detectorRAF = null;

      if (__zxingReader) {
        try {
          __zxingReader.reset();
        } catch (e) {
          console.warn("ZXing reset error:", e);
        }
        __zxingReader = null;
      }

      if (__mediaStream) {
        try {
          __mediaStream
            .getTracks()
            .forEach((track) => {
              try {
                track.stop();
              } catch (e) {}
            });
        } catch (e) {}
        __mediaStream = null;
      }

      try {
        video.pause();
      } catch (e) {}

      try {
        video.srcObject = null;
      } catch (e) {}

      modal.style.display = "none";

      closeBtn.onclick = null;
      manualBtn.onclick = null;
    }

    function finish(code) {

      if (settled) {
        return;
      }

      if (!code) {
        return;
      }

      const cleanedCode = String(code).trim();

      if (!cleanedCode) {
        return;
      }

      settled = true;

      console.log("=================================");
      console.log("EDUVAULT BARCODE SCANNED");
      console.log("VALUE:", cleanedCode);
      console.log("=================================");

      cleanup();

      if (__activeCancelFn === cancel) {
        __activeCancelFn = null;
      }

      resolve(cleanedCode);
    }

    function cancel() {

      if (settled) {
        return;
      }

      settled = true;

      cleanup();

      if (__activeCancelFn === cancel) {
        __activeCancelFn = null;
      }

      reject(new Error("cancelled"));
    }

    __activeCancelFn = cancel;

    closeBtn.onclick = cancel;

    manualBtn.onclick = () => {
      const code = prompt(
        "Enter the number/code printed under your ID card's barcode:"
      );

      if (code && code.trim()) {
        finish(code.trim());
      }
    };

    if (typeof ZXing !== "undefined") {
      console.log("EduVault Scanner: Using ZXing");
      startZXing(video, status, finish);
    }
    else if ("BarcodeDetector" in window) {
      console.log("EduVault Scanner: Using native BarcodeDetector");
      startNativeDetector(video, status, finish);
    }
    else {
      status.textContent =
        "Barcode scanning is not available in this browser. Please enter your ID manually.";
      status.style.color = "#FF7A6E";
    }
  });
}

function startZXing(video, status, finish) {

  try {

    const hints = new Map();

    hints.set(
      ZXing.DecodeHintType.POSSIBLE_FORMATS,
      [ZXing.BarcodeFormat.CODE_128]
    );

    hints.set(
      ZXing.DecodeHintType.TRY_HARDER,
      true
    );

    __zxingReader = new ZXing.BrowserMultiFormatReader(hints);

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 },
        frameRate: { ideal: 30, max: 60 },
        focusMode: "continuous"
      }
    };

    status.textContent = "Camera ready. Keep the barcode horizontal and steady.";
    status.style.color = "#C9D3DE";

    const scannerPromise = __zxingReader.decodeFromConstraints(
      constraints,
      video,
      (result, error) => {
        if (result) {
          const text = result.getText() ? result.getText().trim() : "";
          if (!text) return;

          console.log("ZXing detected:", text);
          status.textContent = "Card detected: " + text;
          status.style.color = "#4FE3B0";
          finish(text);
        }
      }
    );

    if (scannerPromise && typeof scannerPromise.catch === "function") {
      scannerPromise.catch((error) => {
        console.error("ZXing camera error:", error);
        status.textContent = "Couldn't access the camera. Check camera permission.";
        status.style.color = "#FF7A6E";
      });
    }

    video.addEventListener(
      "loadedmetadata",
      async () => {
        try {
          if (!video.srcObject) return;

          const tracks = video.srcObject.getVideoTracks();
          if (!tracks.length) return;

          const track = tracks[0];
          console.log("Camera:", track.label);

          if (typeof track.getCapabilities === "function") {
            const capabilities = track.getCapabilities();
            console.log("Camera capabilities:", capabilities);

            if (capabilities.focusMode && capabilities.focusMode.includes("continuous")) {
              try {
                await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
                console.log("Continuous autofocus enabled");
              } catch (focusError) {
                console.warn("Could not enable autofocus:", focusError);
              }
            }

            if (capabilities.zoom && capabilities.zoom.min !== undefined && capabilities.zoom.max !== undefined) {
              const minZoom = capabilities.zoom.min;
              const maxZoom = capabilities.zoom.max;

              if (maxZoom > minZoom) {
                const desiredZoom = Math.min(minZoom + 1, maxZoom);
                try {
                  await track.applyConstraints({ advanced: [{ zoom: desiredZoom }] });
                  console.log("Camera zoom:", desiredZoom);
                } catch (zoomError) {
                  console.warn("Could not apply zoom:", zoomError);
                }
              }
            }
          }
        } catch (cameraError) {
          console.warn("Camera optimization error:", cameraError);
        }
      },
      { once: true }
    );

  } catch (error) {

    console.error("ZXing initialization error:", error);

    if ("BarcodeDetector" in window) {
      status.textContent = "Switching to browser scanner...";
      startNativeDetector(video, status, finish);
    } else {
      status.textContent = "Couldn't start the scanner. Please enter your ID manually.";
      status.style.color = "#FF7A6E";
    }
  }
}

async function startNativeDetector(video, status, finish) {

  try {

    let formats = SCAN_FORMATS_NATIVE;

    try {
      const supported = await BarcodeDetector.getSupportedFormats();
      formats = SCAN_FORMATS_NATIVE.filter((format) => supported.includes(format));
      if (!formats.length) formats = SCAN_FORMATS_NATIVE;
    } catch (error) {
      console.warn("Could not get BarcodeDetector formats:", error);
    }

    const detector = new BarcodeDetector({ formats });

    __mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 },
        frameRate: { ideal: 30, max: 60 },
        focusMode: "continuous"
      }
    });

    video.srcObject = __mediaStream;
    await video.play();

    try {
      const tracks = __mediaStream.getVideoTracks();
      if (tracks.length) {
        const track = tracks[0];
        if (typeof track.getCapabilities === "function") {
          const capabilities = track.getCapabilities();
          if (capabilities.focusMode && capabilities.focusMode.includes("continuous")) {
            await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
          }
        }
      }
    } catch (focusError) {
      console.warn("Native autofocus unavailable:", focusError);
    }

    status.textContent = "Camera ready. Keep the barcode horizontal and steady.";

    let lastScanTime = 0;

    const scanLoop = async () => {
      const now = performance.now();

      if (now - lastScanTime < 120) {
        __detectorRAF = requestAnimationFrame(scanLoop);
        return;
      }

      lastScanTime = now;

      try {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const codes = await detector.detect(video);
          if (codes && codes.length) {
            const rawValue = codes[0].rawValue ? codes[0].rawValue.trim() : "";
            if (rawValue) {
              console.log("Native BarcodeDetector detected:", rawValue);
              status.textContent = "Card detected: " + rawValue;
              status.style.color = "#4FE3B0";
              finish(rawValue);
              return;
            }
          }
        }
      } catch (error) {
        // Detection errors on individual frames are normal. Keep scanning.
      }

      __detectorRAF = requestAnimationFrame(scanLoop);
    };

    __detectorRAF = requestAnimationFrame(scanLoop);

  } catch (error) {
    console.error("Native BarcodeDetector error:", error);
    status.textContent = "Couldn't access the camera. Check camera permission.";
    status.style.color = "#FF7A6E";
  }
}

async function isCameraAvailable() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return false;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((device) => device.kind === "videoinput");
  } catch (error) {
    console.warn("Camera availability check failed:", error);
    return false;
  }
}
