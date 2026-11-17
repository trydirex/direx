// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from "vitest";

vi.mock("./application/raw-pg");
vi.doMock("../x/adapters/repo");
vi.mock("@direx/db");
