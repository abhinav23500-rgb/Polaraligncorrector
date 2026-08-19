const $ = id => document.getElementById(id);

const shots = [];
const MIN_SHOTS = 3;

// Used by the custom-amount button; QR scanning works independently.
const SUPPORT_UPI_ID = "9060269432@axl";
const SUPPORT_PAYEE_NAME = "Support this project";

const rad = degrees => degrees * Math.PI / 180;
const deg = radians => radians * 180 / Math.PI;

const clamp = value => Math.max(-1, Math.min(1, value));

const dot = (a, b) =>
  a.reduce((sum, value, index) => sum + value * b[index], 0);

const normalize = vector => {
  const size = Math.hypot(...vector);
  return vector.map(value => value / size);
};

const skyVector = (ra, dec) => [
  Math.cos(rad(dec)) * Math.cos(rad(ra)),
  Math.cos(rad(dec)) * Math.sin(rad(ra)),
  Math.sin(rad(dec))
];

const formatDegrees = value => `${Math.abs(value).toFixed(1)}°`;

function detectLocation() {
  if (!navigator.geolocation) {
    $("status").textContent =
      "Location is not available on this laptop. Enter it manually.";
    return;
  }

  $("status").textContent =
    "Detecting laptop location. Please wait...";

  navigator.geolocation.getCurrentPosition(
    position => {
      $("lat").value =
        position.coords.latitude.toFixed(5);

      $("lon").value =
        position.coords.longitude.toFixed(5);

      syncHemisphere();

      $("status").textContent =
        "Location detected successfully.";
    },
    error => {
      const messages = {
        1: "Location permission was denied.",
        2: "Windows could not determine this laptop's location.",
        3: "Location detection timed out."
      };

      $("status").textContent =
        `${messages[error.code] || "Could not detect location."} Enter it manually.`;
    },
    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 60000
    }
  );
}

function syncHemisphere() {
  $("hemisphere").value =
    Number($("lat").value) < 0 ? "south" : "north";
}

$("locate").onclick = detectLocation;
$("lat").onchange = syncHemisphere;

function handlePhotoSelection(event) {
  const file = event.target.files[0];

  if (file) {
    solveImage(file, new Date().toISOString());
  }

  event.target.value = "";
}

$("phone-photo").onchange = handlePhotoSelection;
$("photo").onchange = handlePhotoSelection;

$("phone-capture").onclick = () => $("phone-photo").click();
$("import-photo").onclick = () => $("photo").click();

$("finish").onclick = calculatePolarError;

$("reset").onclick = () => {
  location.reload();
};

function closeSupportDialog() {
  $("support-dialog").close();
  $("amount-form").hidden = true;
  $("payment-message").textContent = "";
}

$("support-toggle").onclick = () => $("support-dialog").showModal();
$("support-close").onclick = closeSupportDialog;

$("support-dialog").addEventListener("click", event => {
  if (event.target === $("support-dialog")) {
    closeSupportDialog();
  }
});

$("add-amount").onclick = () => {
  $("amount-form").hidden = false;
  $("support-amount").focus();
};

$("amount-form").onsubmit = event => {
  event.preventDefault();

  const amount = Number($("support-amount").value);

  if (!Number.isFinite(amount) || amount <= 0) {
    $("payment-message").textContent = "Enter an amount greater than ₹0.";
    return;
  }

  if (!SUPPORT_UPI_ID) {
    $("payment-message").textContent =
      "Add your UPI ID to SUPPORT_UPI_ID in public/app.js to enable this option.";
    return;
  }

  const paymentUrl = new URL("upi://pay");
  paymentUrl.searchParams.set("pa", SUPPORT_UPI_ID);
  paymentUrl.searchParams.set("pn", SUPPORT_PAYEE_NAME);
  paymentUrl.searchParams.set("am", amount.toFixed(2));
  paymentUrl.searchParams.set("cu", "INR");

  window.location.href = paymentUrl.toString();
};

async function solveImage(file, capturedAt) {
  if (shots.length >= 10) {
    $("status").textContent =
      "You have 10 solved photos. Calculate alignment or start over.";
    return;
  }

  const previewUrl = URL.createObjectURL(file);

  $("status").textContent =
    `Solving Photo ${shots.length + 1} locally with ASTAP…`;

  const form = new FormData();

  form.append("image", file);
  form.append("capturedAt", capturedAt);

  try {
    const response = await fetch("/api/solve", {
      method: "POST",
      body: form
    });

    const solved = await response.json();

    if (!response.ok) {
      throw new Error(solved.error || "Plate solve failed.");
    }

    shots.push({
      ...solved,
      previewUrl
    });

    addShotCard(shots.length, solved, previewUrl);

    $("reset").hidden = false;
    $("finish").hidden = shots.length < MIN_SHOTS;

    if (shots.length < MIN_SHOTS) {
      $("status").textContent =
        `Photo ${shots.length} solved. Rotate only RA by 10–20°, ` +
        `then take Photo ${shots.length + 1}.`;
    } else {
      $("status").textContent =
        `${shots.length} photos solved. You can take up to 10, ` +
        "or calculate alignment now.";
    }
  } catch (error) {
    URL.revokeObjectURL(previewUrl);

    $("status").textContent =
      `Could not solve the photo: ${error.message}`;
  }
}

function addShotCard(number, solved, previewUrl) {
  const card = document.createElement("article");

  card.className = "shot solved-card";

  card.innerHTML = `
    <div class="solved-image-frame">
      <img src="${previewUrl}" alt="Solved sky photo ${number}">
      <div class="solved-badge">✓ PLATE SOLVED</div>
    </div>

    <div class="solved-info">
      <strong>Photo ${number}</strong>
      <span>RA: ${solved.ra.toFixed(4)}°</span>
      <span>Dec: ${solved.dec.toFixed(4)}°</span>
    </div>
  `;

  $("shots").append(card);
}

/*
  Jacobi eigenvalue iteration.

  The smallest eigenvector of the point covariance matrix is the
  normal of the best-fit plane. That normal is the RA-axis direction.
*/
function smallestEigenvector(matrix) {
  const a = matrix.map(row => [...row]);

  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ];

  for (let iteration = 0; iteration < 32; iteration++) {
    let p = 0;
    let q = 1;

    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        if (Math.abs(a[i][j]) > Math.abs(a[p][q])) {
          p = i;
          q = j;
        }
      }
    }

    if (Math.abs(a[p][q]) < 1e-12) {
      break;
    }

    const angle = 0.5 * Math.atan2(
      2 * a[p][q],
      a[q][q] - a[p][p]
    );

    const c = Math.cos(angle);
    const s = Math.sin(angle);

    for (let k = 0; k < 3; k++) {
      const apk = a[p][k];
      const aqk = a[q][k];

      a[p][k] = c * apk - s * aqk;
      a[q][k] = s * apk + c * aqk;
    }

    for (let k = 0; k < 3; k++) {
      const akp = a[k][p];
      const akq = a[k][q];

      a[k][p] = c * akp - s * akq;
      a[k][q] = s * akp + c * akq;

      const vkp = v[k][p];
      const vkq = v[k][q];

      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }

  let index = 0;

  if (a[1][1] < a[index][index]) {
    index = 1;
  }

  if (a[2][2] < a[index][index]) {
    index = 2;
  }

  return normalize(v.map(row => row[index]));
}

function fitAxis(points) {
  const centre = points
    .reduce(
      (sum, point) => sum.map((value, i) => value + point[i]),
      [0, 0, 0]
    )
    .map(value => value / points.length);

  const covariance = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];

  points.forEach(point => {
    const difference = point.map(
      (value, i) => value - centre[i]
    );

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        covariance[i][j] += difference[i] * difference[j];
      }
    }
  });

  const axis = smallestEigenvector(covariance);

  const planeOffset = dot(axis, centre);

  const rms = deg(
    Math.sqrt(
      points.reduce(
        (sum, point) =>
          sum + (dot(axis, point) - planeOffset) ** 2,
        0
      ) / points.length
    )
  );

  const pairAngles = [];

  points.forEach((point, index) => {
    points.slice(index + 1).forEach(other => {
      pairAngles.push(
        deg(Math.acos(clamp(dot(point, other))))
      );
    });
  });

  const span = Math.max(...pairAngles);

  return { axis, rms, span };
}

async function calculatePolarError() {
  const latitude = Number($("lat").value);
  const longitude = Number($("lon").value);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    $("status").textContent =
      "Enter latitude and longitude before calculating.";
    return;
  }

  if (shots.length < MIN_SHOTS) {
    $("status").textContent =
      `Take at least ${MIN_SHOTS} solved photos first.`;
    return;
  }

  const points = shots.map(shot => skyVector(shot.ra, shot.dec));

  const fitted = fitAxis(points);

  if (fitted.span < 25) {
    $("status").textContent =
      `The total RA rotation is only ${formatDegrees(fitted.span)}. ` +
      "Repeat with a wider 25°+ arc.";
    return;
  }

  const truePole = skyVector(
    0,
    $("hemisphere").value === "south" ? -90 : 90
  );

  const axis =
    dot(fitted.axis, truePole) < 0
      ? fitted.axis.map(value => -value)
      : fitted.axis;

  const axisRa =
    (deg(Math.atan2(axis[1], axis[0])) + 360) % 360;

  const axisDec = deg(Math.asin(axis[2]));

  const totalError = deg(
    Math.acos(clamp(dot(axis, truePole)))
  );

  const middleShot = shots[Math.floor(shots.length / 2)];

  try {
    const response = await fetch("/api/horizon", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ra: axisRa,
        dec: axisDec,
        latitude,
        longitude,
        hemisphere: $("hemisphere").value,
        capturedAt: middleShot.capturedAt
      })
    });

    const horizon = await response.json();

    if (!response.ok) {
      throw new Error(horizon.error);
    }

    let quality = "poor — check for flexure or a bad solve";

    if (fitted.rms < 0.03) {
      quality = "excellent";
    } else if (fitted.rms < 0.1) {
      quality = "usable";
    }

    $("result").hidden = false;
    $("result").className = "result";

    $("result").innerHTML = `
      <h2>Polar Alignment Result</h2>

      <p class="big">
        Total error: ${formatDegrees(totalError)}
      </p>

      <div class="grid">
        <p>
          <strong>Altitude correction</strong><br>
          ${
            horizon.altitudeMove >= 0
              ? "Raise"
              : "Lower"
          }
          the RA axis by
          ${formatDegrees(horizon.altitudeMove)}
        </p>

        <p>
          <strong>Azimuth correction</strong><br>
          Move the mount
          ${
            horizon.azimuthMove >= 0
              ? "east"
              : "west"
          }
          by
          ${formatDegrees(horizon.azimuthMove)}
        </p>

        <p>
          <strong>Fit quality</strong><br>
          ${quality}<br>
          Scatter: ${formatDegrees(fitted.rms)}<br>
          RA arc: ${formatDegrees(fitted.span)}
        </p>

        <p>
          <strong>Measured RA axis</strong><br>
          RA ${axisRa.toFixed(3)}°<br>
          Dec ${axisDec.toFixed(3)}°
        </p>
      </div>

      <p>
        Make only physical Alt/Az adjustments, then repeat the
        sequence to verify. Confirm the east/west direction with
        a small test adjustment on your specific mount.
      </p>
    `;

    $("status").textContent =
      "Done. Apply the corrections and repeat to verify.";
  } catch (error) {
    $("status").textContent =
      `Could not calculate alignment: ${error.message}`;
  }
}
