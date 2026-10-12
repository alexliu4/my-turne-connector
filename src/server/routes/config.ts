import { Elysia, t } from "elysia";
import {
  type AppLaunchPreferenceStore,
  FileSystemAppLaunchPreferenceStore,
  validateAppDefinition,
} from "../services/app-launch-config";
import {
  type MacroPreferenceStore,
  FileSystemMacroPreferenceStore,
  validateMacroDefinition,
} from "../services/macro-config";
import { createLogger } from "../utils/logger";
import { isLocalhostRequest } from "../utils/request-security";

const log = createLogger("ConfigRoutes");

export function createConfigRoutes(
  appStore: AppLaunchPreferenceStore = new FileSystemAppLaunchPreferenceStore(),
  macroStore: MacroPreferenceStore = new FileSystemMacroPreferenceStore(),
  platform: NodeJS.Platform = process.platform,
) {
  return new Elysia({ prefix: "/api/config" })
    .onBeforeHandle(({ request, set }) => {
      if (!isLocalhostRequest(request, platform)) {
        log.warn(`Rejecting non-localhost config request from ${request.headers.get("host") || "unknown"}`);
        set.status = 403;
        return { error: "Configuration API is localhost-only" };
      }
    })
    .get("/apps", () => {
      const config = appStore.load();
      return { status: "ok", apps: Object.values(config.apps) };
    })
    .post(
      "/apps",
      ({ body, set }) => {
        const validated = validateAppDefinition((body as any)?.id ?? "", body);
        if (!validated) {
          set.status = 400;
          return { error: "Invalid application definition format or missing fields" };
        }

        const config = appStore.load();
        config.apps[validated.id] = validated;
        appStore.save(config);
        log.info(`Updated app launch config for: ${validated.id}`);
        return { status: "ok", app: validated };
      },
      {
        body: t.Object({
          id: t.String(),
          name: t.String(),
          target: t.String(),
          fallbacks: t.Optional(t.Array(t.String())),
          enabled: t.Optional(t.Boolean()),
        }),
      },
    )
    .delete(
      "/apps/:id",
      ({ params: { id }, set }) => {
        const config = appStore.load();
        if (!config.apps[id]) {
          set.status = 404;
          return { error: `Application '${id}' not found` };
        }
        delete config.apps[id];
        appStore.save(config);
        log.info(`Deleted app launch config: ${id}`);
        return { status: "ok", deletedId: id };
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    )
    .get("/macros", () => {
      const config = macroStore.load();
      return { status: "ok", macros: Object.values(config.macros) };
    })
    .post(
      "/macros",
      ({ body, set }) => {
        const validated = validateMacroDefinition((body as any)?.id ?? "", body);
        if (!validated) {
          set.status = 400;
          return { error: "Invalid macro definition format or missing fields" };
        }

        const config = macroStore.load();
        config.macros[validated.id] = validated;
        macroStore.save(config);
        log.info(`Updated macro config for: ${validated.id}`);
        return { status: "ok", macro: validated };
      },
      {
        body: t.Object({
          id: t.String(),
          name: t.String(),
          action: t.Any(),
          enabled: t.Optional(t.Boolean()),
        }),
      },
    )
    .delete(
      "/macros/:id",
      ({ params: { id }, set }) => {
        const config = macroStore.load();
        if (!config.macros[id]) {
          set.status = 404;
          return { error: `Macro '${id}' not found` };
        }
        delete config.macros[id];
        macroStore.save(config);
        log.info(`Deleted macro config: ${id}`);
        return { status: "ok", deletedId: id };
      },
      {
        params: t.Object({
          id: t.String(),
        }),
      },
    );
}
