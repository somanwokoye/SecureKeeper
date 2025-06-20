import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import {
  configureSession,
  isAuthenticated,
  login,
  register,
  logout,
  getCurrentUser,
} from "./auth";
import {
  calculatePasswordStrength,
  generatePassword as generatePasswordUtil,
  isValidEmail,
  isStrongPassword,
} from "./utils";
import {
  insertPasswordSchema,
  updatePasswordSchema,
  loginUserSchema,
  insertUserSchema,
  passwordGeneratorSchema,
  type PasswordGenerator,
} from "@shared/schema";

// Rate limiting store (simple in-memory for demo; replace with Redis or DB in production)
const loginAttempts: Record<string, { count: number; lastAttempt: number }> = {};
const MAX_ATTEMPTS = 5;
const BLOCK_TIME_MS = 15 * 60 * 1000; // 15 mins block

interface AuthenticatedRequest extends Request {
  session: Request['session'] & {
    userId?: number;
  };
}

function handleServerError(res: Response, message = "Internal Server Error") {
  return res.status(500).json({ message });
}

// Rate limiter middleware for login route
async function loginRateLimiter(req: Request, res: Response, next: () => void) {
  const ip = (req.headers["x-forwarded-for"] || req.ip) as string;
  const now = Date.now();

  if (!loginAttempts[ip]) {
    loginAttempts[ip] = { count: 0, lastAttempt: now };
  }

  const attemptInfo = loginAttempts[ip];

  // Reset count if last attempt was long ago
  if (now - attemptInfo.lastAttempt > BLOCK_TIME_MS) {
    attemptInfo.count = 0;
  }

  attemptInfo.lastAttempt = now;

  if (attemptInfo.count >= MAX_ATTEMPTS) {
    return res.status(429).json({
      message: "Too many login attempts. Please try again after 15 minutes.",
    });
  }

  // Proceed to login route handler
  res.locals.loginAttemptInfo = attemptInfo;
  next();
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Configure session & cookies
  configureSession(app);

  // ----- AUTH ROUTES -----
  app.post(
    "/api/auth/login",
    loginRateLimiter,
    async (req: Request, res: Response) => {
      try {
        const result = loginUserSchema.safeParse(req.body);
        if (!result.success) {
          return res.status(400).json({
            message: result.error.errors[0].message,
          });
        }

        // Call login logic and check result properly
        await login(req, res);

        // If we get here, login was successful
        const attemptInfo = res.locals.loginAttemptInfo;
        if (attemptInfo) {
          attemptInfo.count = 0;
        }

      } catch (error) {
        console.error(
          "Login error:",
          error instanceof Error ? error.message : error
        );

        // Increment attempt count on failure
        const attemptInfo = res.locals.loginAttemptInfo;
        if (attemptInfo) {
          attemptInfo.count++;
        }

        return handleServerError(res, "An error occurred during login");
      }
    }
  );

  app.post("/api/auth/register", async (req: Request, res: Response) => {
    try {
      const result = insertUserSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({
          message: result.error.errors[0].message,
        });
      }

      const { email, password } = result.data;

      if (!isValidEmail(email)) {
        return res.status(400).json({ message: "Invalid email format" });
      }

      if (!isStrongPassword(password)) {
        return res.status(400).json({
          message: "Password is too weak. It must have uppercase, lowercase, numbers, symbols and be at least 8 characters long.",
        });
      }

      await register(req, res);
    } catch (error) {
      console.error(
        "Registration error:",
        error instanceof Error ? error.message : error
      );
      return handleServerError(res, "An error occurred during registration");
    }
  });

  app.post("/api/auth/logout", async (req: Request, res: Response) => {
    try {
      await logout(req, res);
    } catch (error) {
      console.error(
        "Logout error:",
        error instanceof Error ? error.message : error
      );
      return handleServerError(res, "Failed to logout");
    }
  });

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    try {
      await getCurrentUser(req, res);
    } catch (error) {
      console.error(
        "Get current user error:",
        error instanceof Error ? error.message : error
      );
      return handleServerError(res, "Failed to get current user");
    }
  });

  // ----- PASSWORD ROUTES -----
  app.get(
    "/api/passwords",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const userId = req.session.userId;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });

        const passwords = await storage.getPasswordsByUserId(userId);
        res.json(passwords);
      } catch (error) {
        console.error("Get passwords error:", error);
        return handleServerError(res, "Failed to retrieve passwords");
      }
    }
  );

  app.get(
    "/api/passwords/:id",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const userId = req.session.userId;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });

        const passwordId = parseInt(req.params.id);
        if (isNaN(passwordId) || passwordId <= 0) {
          return res.status(400).json({ message: "Invalid password ID" });
        }

        const password = await storage.getPasswordById(passwordId, userId);
        if (!password) {
          return res.status(404).json({ message: "Password not found" });
        }

        res.json(password);
      } catch (error) {
        console.error("Get password error:", error);
        return handleServerError(res, "Failed to retrieve password");
      }
    }
  );

  app.post(
    "/api/passwords",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const userId = req.session.userId;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });

        const result = insertPasswordSchema.safeParse(req.body);
        if (!result.success) {
          return res.status(400).json({
            message: result.error.errors[0].message,
          });
        }

        // Calculate password strength and add it to the data
        const strength = calculatePasswordStrength(result.data.encryptedPassword);
        const passwordData = { ...result.data, strength };

        const newPassword = await storage.createPassword(passwordData, userId);

        // Log activity
        await storage.createActivityLog({
          userId,
          action: "create_password",
          details: `Created password for ${newPassword.title}`,
          ipAddress: (req.headers["x-forwarded-for"] || req.ip) as string || "",
          userAgent: req.headers["user-agent"] || "",
        });

        res.status(201).json(newPassword);
      } catch (error) {
        console.error("Create password error:", error);
        return handleServerError(res, "Failed to create password");
      }
    }
  );

  app.put(
    "/api/passwords/:id",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const userId = req.session.userId;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });

        const passwordId = parseInt(req.params.id);
        if (isNaN(passwordId) || passwordId <= 0) {
          return res.status(400).json({ message: "Invalid password ID" });
        }

        const result = updatePasswordSchema.safeParse(req.body);
        if (!result.success) {
          return res.status(400).json({
            message: result.error.errors[0].message,
          });
        }

        // Calculate strength if password is being updated
        let updateData = result.data;
        if (result.data.encryptedPassword) {
          const strength = calculatePasswordStrength(result.data.encryptedPassword);
          updateData = { ...result.data, strength } as typeof result.data & { strength: number };
        }

        const updatedPassword = await storage.updatePassword(
          passwordId,
          userId,
          updateData
        );

        if (!updatedPassword) {
          return res.status(404).json({ message: "Password not found" });
        }

        // Log activity
        await storage.createActivityLog({
          userId,
          action: "update_password",
          details: `Updated password for ${updatedPassword.title}`,
          ipAddress: (req.headers["x-forwarded-for"] || req.ip) as string || "",
          userAgent: req.headers["user-agent"] || "",
        });

        res.json(updatedPassword);
      } catch (error) {
        console.error("Update password error:", error);
        return handleServerError(res, "Failed to update password");
      }
    }
  );

  app.delete(
    "/api/passwords/:id",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const userId = req.session.userId;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });

        const passwordId = parseInt(req.params.id);
        if (isNaN(passwordId) || passwordId <= 0) {
          return res.status(400).json({ message: "Invalid password ID" });
        }

        const success = await storage.deletePassword(passwordId, userId);
        if (!success) {
          return res.status(404).json({ message: "Password not found" });
        }

        // Log activity
        await storage.createActivityLog({
          userId,
          action: "delete_password",
          details: `Deleted password with id ${passwordId}`,
          ipAddress: (req.headers["x-forwarded-for"] || req.ip) as string || "",
          userAgent: req.headers["user-agent"] || "",
        });

        res.json({ message: "Password deleted successfully" });
      } catch (error) {
        console.error("Delete password error:", error);
        return handleServerError(res, "Failed to delete password");
      }
    }
  );

  // ----- STATS ROUTES -----
  app.get(
    "/api/password-stats",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const userId = req.session.userId;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });

        const stats = await storage.getPasswordStats(userId);
        res.json(stats);
      } catch (error) {
        console.error("Get password stats error:", error);
        return handleServerError(res, "Failed to retrieve password statistics");
      }
    }
  );

  // ----- SECURITY ALERTS ROUTES -----
  app.get(
    "/api/security-alerts",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const userId = req.session.userId;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });

        const alerts = await storage.getSecurityAlertsByUserId(userId);
        res.json(alerts);
      } catch (error) {
        console.error("Get security alerts error:", error);
        return handleServerError(res, "Failed to retrieve security alerts");
      }
    }
  );

  app.post(
    "/api/security-alerts/:id/resolve",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const userId = req.session.userId;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });

        const alertId = parseInt(req.params.id);
        if (isNaN(alertId) || alertId <= 0) {
          return res.status(400).json({ message: "Invalid alert ID" });
        }

        const success = await storage.resolveSecurityAlert(alertId, userId);
        if (!success) {
          return res.status(404).json({ message: "Security alert not found" });
        }

        res.json({ message: "Alert resolved successfully" });
      } catch (error) {
        console.error("Resolve alert error:", error);
        return handleServerError(res, "Failed to resolve alert");
      }
    }
  );

  // ----- ACTIVITY LOGS -----
  app.get(
    "/api/activity-logs",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const userId = req.session.userId;
        if (!userId) return res.status(401).json({ message: "Unauthorized" });

        const logs = await storage.getActivityLogsByUserId(userId, 20);
        res.json(logs);
      } catch (error) {
        console.error("Get activity logs error:", error);
        return handleServerError(res, "Failed to retrieve activity logs");
      }
    }
  );

  // Add a health check endpoint
app.get("/api/health", (req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

  // ----- PASSWORD GENERATOR -----
  app.post(
    "/api/generate-password",
    isAuthenticated,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = passwordGeneratorSchema.safeParse(req.body);
        if (!result.success) {
          return res.status(400).json({
            message: result.error.errors[0].message,
          });
        }

        const { length, includeUppercase, includeLowercase, includeNumbers, includeSymbols } = result.data;

        const password = generatePasswordUtil(
          length,
          includeUppercase,
          includeLowercase,
          includeNumbers,
          includeSymbols
        );

        const strength = calculatePasswordStrength(password);

        res.json({ password, strength });
      } catch (error) {
        console.error("Generate password error:", error);
        return handleServerError(res, "Failed to generate password");
      }
    }
  );

  // Add CORS headers middleware if needed
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
    } else {
      next();
    }
  });

  app.use((error: any, req: Request, res: Response, next: NextFunction) => {
    console.error('Unhandled error:', error);

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  });

  // Start HTTP server and return it for app.listen usage
  return createServer(app);
}