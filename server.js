import "dotenv/config";
import express from "express";
import multer from "multer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { Horizon, Observer } from "astronomy-engine";

const app = express();

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' blob:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'"
  ].join("; "));
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(self), geolocation=(self), microphone=()");

  if (req.headers["x-forwarded-proto"] === "https") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=15552000; includeSubDomains"
    );
  }

  next();
});

function createRateLimiter({ windowMs, max }) {
  const requests = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress;
    const recentRequests = (requests.get(ip) || []).filter(
      timestamp => now - timestamp < windowMs
    );

    if (recentRequests.length >= max) {
      res.status(429).json({
        error: "Too many requests. Please wait a few minutes and try again."
      });
      return;
    }

    recentRequests.push(now);
    requests.set(ip, recentRequests);
    next();
  };
}

const solveRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 8
});

const horizonRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30
});

function isSupportedImage(file) {
  const isJpeg =
    file.buffer.length >= 3 &&
    file.buffer[0] === 0xff &&
    file.buffer[1] === 0xd8 &&
    file.buffer[2] === 0xff;

  const isPng =
    file.buffer.length >= 8 &&
    file.buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );

  return isJpeg || isPng;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const execFileAsync = promisify(execFile);

app.use(express.static("public"));
app.use(express.json({ limit: "100kb" }));

function readWcsNumber(text, key) {
  const match = text.match(
    new RegExp(
      `${key}\\s*=\\s*([+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:E[+-]?\\d+)?)`,
      "i"
    )
  );

  if (!match) {
    throw new Error(`ASTAP solved the image but ${key} was missing.`);
  }

  return Number(match[1]);
}

async function readSolvedCoordinates(outputBase) {
  for (const file of [`${outputBase}.wcs`, `${outputBase}.ini`]) {
    try {
      const text = await readFile(file, "latin1");

      return {
        ra: readWcsNumber(text, "CRVAL1"),
        dec: readWcsNumber(text, "CRVAL2")
      };
    } catch {
      // Try the next ASTAP output.
    }
  }

  throw new Error(
    "ASTAP did not create a readable solved WCS file. " +
    "Check its database and field of view."
  );
}

app.post("/api/solve", solveRateLimit, upload.single("image"), async (req, res) => {
  let workFolder;

  try {
    if (!req.file) {
      throw new Error("No photo was received.");
    }

    if (!isSupportedImage(req.file)) {
      throw new Error("Upload a valid JPEG or PNG image.");
    }

    const astapPath =
      process.env.ASTAP_PATH ||
      "C:\\Program Files\\astap\\astap_cli.exe";

    const databasePath =
      process.env.ASTAP_DATABASE_PATH ||
      "C:\\Program Files\\astap";

    const fov = Number(process.env.ASTAP_FOV_DEG);

    workFolder = await mkdtemp(join(tmpdir(), "polar-align-"));

    const inputImage = join(
      workFolder,
      `phone-photo${extname(req.file.originalname) || ".jpg"}`
    );

    const outputBase = join(workFolder, "solved");

    await writeFile(inputImage, req.file.buffer);

    const args = [
      "-f", inputImage,
      "-d", databasePath,
      "-r", process.env.ASTAP_RADIUS_DEG || "180",
      "-speed", "slow",
      "-o", outputBase,
      "-wcs",
      "-log"
    ];

    // A zero-degree FOV is invalid. Omit the option for ASTAP auto-search.
    if (Number.isFinite(fov) && fov > 0) {
      args.splice(4, 0, "-fov", String(fov));
    }

    try {
      await execFileAsync(astapPath, args, {
        timeout: 300000,
        maxBuffer: 1024 * 1024
      });
    } catch (astapError) {
      const details =
        `${astapError.stdout || ""}\n${astapError.stderr || ""}`
          .trim()
          .slice(-800);

      console.error("ASTAP solve failed:", details);

      throw new Error(
        "ASTAP could not solve this photo. " +
        "Check the star database, focus, and field of view."
      );
    }

    const solved = await readSolvedCoordinates(outputBase);

    res.json({
      ...solved,
      capturedAt: req.body.capturedAt || new Date().toISOString()
    });
  } catch (error) {
    console.error(error);

    res.status(400).json({
      error: error.message || "Local ASTAP solve failed."
    });
  } finally {
    if (workFolder) {
      await rm(workFolder, {
        recursive: true,
        force: true
      });
    }
  }
});

function signedAngle(angle) {
  return ((angle + 540) % 360) - 180;
}

/*
  Astronomy Engine handles the J2000 coordinate system used by ASTAP.
  This avoids mixing plate-solve coordinates with a hand-written
  current-date sidereal-time calculation.
*/
app.post("/api/horizon", horizonRateLimit, (req, res) => {
  try {
    const {
      ra,
      dec,
      latitude,
      longitude,
      capturedAt,
      hemisphere
    } = req.body;

    if (
      ![ra, dec, latitude, longitude].every(Number.isFinite) ||
      !capturedAt ||
      ra < 0 || ra >= 360 ||
      dec < -90 || dec > 90 ||
      latitude < -90 || latitude > 90 ||
      longitude < -180 || longitude > 180 ||
      !["north", "south"].includes(hemisphere) ||
      Number.isNaN(new Date(capturedAt).getTime())
    ) {
      throw new Error("Invalid alignment data.");
    }

    const observer = new Observer(latitude, longitude, 0);

    const actual = Horizon(
      new Date(capturedAt),
      observer,
      ra / 15,
      dec,
      "normal"
    );

    const poleDec = hemisphere === "south" ? -90 : 90;

    const target = Horizon(
      new Date(capturedAt),
      observer,
      0,
      poleDec,
      "normal"
    );

    res.json({
      actual,
      target,
      altitudeMove: target.altitude - actual.altitude,
      azimuthMove: signedAngle(target.azimuth - actual.azimuth)
    });
  } catch (error) {
    res.status(400).json({
      error:
        error.message ||
        "Could not calculate horizon coordinates."
    });
  }
});

const port = process.env.PORT || 3000;
const host = process.env.HOST || "127.0.0.1";

const server = app.listen(port, host, () => {
  console.log(`Website started: http://${host}:${port}`);
});

server.requestTimeout = 310000;

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "Image must be 25 MB or smaller."
        : "Invalid image upload.";

    res.status(400).json({ error: message });
    return;
  }

  next(error);
});
