import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { startDailyScanner, scanAllSites } from "./services/daily-scanner";
import { newMemberScanner } from "./services/new-member-scanner";
import { registerScannerRoutes } from "./routes-scanner";
import { urlValidatorRouter } from "./routes-url-validator";
import { initScanner } from "./proxy-scanner";
import path from "path";

const app = express();
// Increase JSON payload size limit to 10MB for reward detection
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

// Configure CORS for Chrome extension
app.use(cors({
  origin: [
    // Allow main application and extensions
    /^https?:\/\/localhost:[0-9]+$/,
    /^https?:\/\/127\.0\.0\.1:[0-9]+$/,
    /^chrome-extension:\/\/[a-zA-Z0-9]+$/,
    /.*\.replit\.app$/,
    /.*\.replit\.dev$/,
    '*' // Allow all origins
  ],
  credentials: true, // Allow cookies
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Handle preflight requests
app.options('*', cors());

// Direct routes for extension download - needs to be before catch-all routes
app.get("/extension-download", (req, res) => {
  res.sendFile(path.join(process.cwd(), "extension-download-v8.html"));
});

// Serve extension zip directly
app.get("/extension-download/v8", (req, res) => {
  res.sendFile(path.join(process.cwd(), "spinvault-extension-fixed-v8.zip"));
});

// Serve the bookmarklet page
app.get("/simple-bookmarklet.html", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public/simple-bookmarklet.html"));
});

// Serve the legacy auto-detector script
app.get("/legacy-auto-detector.js", (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(process.cwd(), "public/legacy-auto-detector.js"));
});

// Serve the simple scanner page
app.get("/simple-scan.html", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public/simple-scan.html"));
});

// Serve the console detector script
app.get("/console-detector.js", (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(process.cwd(), "public/console-detector.js"));
});

// Serve the working extension page
app.get("/working-extension.html", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public/working-extension.html"));
});

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);
  
  // Set up scanner routes for our improved extension API
  registerScannerRoutes(app);
  
  // Add URL validator routes
  app.use(urlValidatorRouter);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on port 5000
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = 5000;
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
    
    // Start the daily scanning service for rewards
    try {
      // Start both scanning systems for maximum reliability
      startDailyScanner();
      initScanner();
      log('Daily scanning services for rewards have been started');
      
      // Run an immediate scan to populate the offerings database
      log('Running initial reward scan...');
      scanAllSites();
      
      // Start new member offer validation scanner
      log('Starting new member offer validation...');
      newMemberScanner.validateExistingOffers();
      
      // Add standard offers for all 20 sites
      log('Adding standard offers for all 20 gambling sites...');
      newMemberScanner.addStandardNewMemberOffers();
      
      // Set up daily new member offer scanning (every 24 hours)
      setInterval(() => {
        newMemberScanner.updateDatabaseWithWorkingOffers();
      }, 24 * 60 * 60 * 1000); 
    } catch (error) {
      console.error('Failed to start daily scanning service:', error);
    }
  });
})();
