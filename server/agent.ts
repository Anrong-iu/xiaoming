import OpenAI from "openai";
import type { ChatMessage } from "../shared/chat.ts";

// 1. 初始化 DeepSeek 客户端
const openai = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY || "",
});

// 2. 本地 API 请求交互
const PORT = process.env.PORT || "3000";
const HOSTS = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
const ENDPOINTS = ["/api/todos", "/api/tasks"];

async function requestApi(pathSuffix: string = "", options?: RequestInit) {
  let lastError = "";
  for (const host of HOSTS) {
    for (const endpoint of ENDPOINTS) {
      const url = `${host}${endpoint}${pathSuffix}`;
      try {
        const headers: Record<string, string> = {};
        if (options?.method !== "DELETE") {
          headers["Content-Type"] = "application/json";
        }
        const res = await fetch(url, {
          ...options,
          headers: {
            ...headers,
            ...(options?.headers || {}),
          },
        });

        // 妥善处理 204 No Content 或空响应体
        if (res.ok) {
          const text = await res.text();
          if (!text || !text.trim()) {
            return { success: true };
          }
          try {
            return JSON.parse(text);
          } catch {
            return { success: true, text };
          }
        }

        const text = await res.text();
        lastError = `HTTP ${res.status}: ${text}`;
      } catch (err: any) {
        lastError = err?.message || String(err);
      }
    }
  }
  return { error: `请求失败: ${lastError}` };
}

// 解包任务列表数据
function extractTaskList(res: any): any[] {
  if (Array.isArray(res)) return res;
  if (res && typeof res === "object") {
    if (Array.isArray(res.todos)) return res.todos;
    if (Array.isArray(res.data)) return res.data;
    if (Array.isArray(res.tasks)) return res.tasks;
  }
  return [];
}

// 获取任务标题
function getTaskTitle(item: any): string {
  if (!item || typeof item !== "object") return "";
  return String(item.title || item.text || item.name || item.content || "").trim();
}

// 剥离口语修饰词
function cleanTitle(str: string): string {
  if (!str) return "";
  return str
    .replace(/(买回来了|买好了|做好了|办好了|取了|拿了|搞定了|已完成|成了|好了|完成|已做|删掉吧|删掉|删除|取消|提醒我|帮我记|帮我|再记|记一下|一条|把|将|这个|那个|保留一条|清理重复|重复|买|做|办|取)/g, "")
    .trim();
}

// 智能模糊匹配
function isTaskMatch(taskTitle: string, queryTitle: string): boolean {
  if (!taskTitle || !queryTitle) return false;
  const rawTask = taskTitle.trim();
  const rawQuery = queryTitle.trim();
  if (rawTask === rawQuery || rawTask.includes(rawQuery) || rawQuery.includes(rawTask)) {
    return true;
  }
  const cleanQ = cleanTitle(rawQuery);
  const cleanT = cleanTitle(rawTask);
  if (cleanQ && (rawTask.includes(cleanQ) || cleanT.includes(cleanQ) || cleanQ.includes(cleanT))) {
    return true;
  }
  if (cleanQ.length >= 2) {
    const chars = cleanQ.split("");
    if (chars.every((ch) => rawTask.includes(ch))) {
      return true;
    }
  }
  return false;
}

// 基础 CRUD 操作封装
async function getTasks() {
  return await requestApi("");
}

async function addTask(title: string) {
  const cleaned = cleanTitle(title) || title || "新待办事项";
  return await requestApi("", {
    method: "POST",
    body: JSON.stringify({ title: cleaned }),
  });
}

// 核心增强点：兼容 PATCH 与 PUT 的更新方法
async function updateTask(id: string, isDone: boolean, title?: string) {
  console.log("👉 Agent 执行更新 任务 ID:", id, "完成状态:", isDone);
  const payload: any = {
    done: isDone,
    completed: isDone,
    isDone: isDone,
    status: isDone ? "completed" : "pending",
  };
  if (title) payload.title = title;

  // 1. 优先尝试 PATCH 请求
  let res = await requestApi(`/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });

  // 2. 如果 PATCH 失败（返回 error），自动降级尝试 PUT
  if (res && res.error) {
    console.log("⚠️ PATCH 接口不匹配，尝试降级为 PUT...");
    res = await requestApi(`/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  return res;
}

async function deleteTask(id: string) {
  console.log("👉 Agent 执行删除 任务 ID:", id);
  return await requestApi(`/${id}`, {
    method: "DELETE",
  });
}

// 统一 Tool 执行过程
async function executeTool(functionName: string, args: any) {
  const safeArgs = args && typeof args === "object" ? args : {};
  let searchTitle = String(safeArgs.title || safeArgs.name || safeArgs.task || "").trim();

  if (functionName === "add_task") {
    return await addTask(searchTitle || "新待办事项");
  } else if (functionName === "list_tasks") {
    return await getTasks();
  } else if (functionName === "complete_task") {
    const res = await getTasks();
    const taskList = extractTaskList(res);
    let targets = taskList.filter((t: any) => {
      const name = getTaskTitle(t);
      if (!name) return false;
      if (!searchTitle) return true;
      return isTaskMatch(name, searchTitle);
    });
    if (targets.length > 0) {
      const results = [];
      for (const target of targets) {
        const r = await updateTask(target.id, true, getTaskTitle(target));
        results.push(r);
      }
      return { success: true, updatedCount: results.length, details: results };
    } else {
      return { error: `未找到匹配"${searchTitle}"的待办任务` };
    }
  } else if (functionName === "delete_task") {
    if (safeArgs.id) {
      const r = await deleteTask(String(safeArgs.id));
      return { success: true, deletedId: safeArgs.id, result: r };
    }
    const res = await getTasks();
    const taskList = extractTaskList(res);
    const keepOne = Boolean(safeArgs.keep_one || safeArgs.deduplicate);

    let targets = taskList.filter((t: any) => {
      const name = getTaskTitle(t);
      if (!name) return false;
      if (!searchTitle) return false;
      return isTaskMatch(name, searchTitle);
    });
    if (targets.length > 0) {
      const toDelete = keepOne && targets.length > 1 ? targets.slice(1) : targets;
      const results = [];
      for (const target of toDelete) {
        const r = await deleteTask(target.id);
        results.push(r);
      }
      return { success: true, deletedCount: results.length, details: results };
    } else {
      return { error: `未找到匹配"${searchTitle}"的待办任务` };
    }
  } else if (functionName === "deduplicate_tasks") {
    const res = await getTasks();
    const taskList = extractTaskList(res);
    const seenTitles = new Set<string>();
    const toDeleteIds: string[] = [];
    for (const t of taskList) {
      const titleKey = cleanTitle(getTaskTitle(t)) || getTaskTitle(t);
      if (seenTitles.has(titleKey)) {
        toDeleteIds.push(t.id);
      } else {
        seenTitles.add(titleKey);
      }
    }
    const results = [];
    for (const id of toDeleteIds) {
      const r = await deleteTask(id);
      results.push(r);
    }
    return { success: true, cleanedCount: results.length, details: results };
  }
  return { error: `未知函数: ${functionName}` };
}

// 3. 定义大模型 Tools Schema
const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "add_task",
      description: "新增一个待办事项",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "待办事项的具体标题" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "获取当前的全部待办事项列表",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "将某个待办事项标记为已完成",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "要标记完成的任务标题" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "删除待办任务。可传入任务id进行精确删除，或传入任务标题title进行匹配删除。彻底移除任务时使用。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "要删除的任务编号 ID（优先使用）" },
          title: { type: "string", description: "要删除的任务标题名称" },
          keep_one: { type: "boolean", description: "清理重复时是否保留一条，默认 false" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deduplicate_tasks",
      description: "自动清理整个清单中的所有重复待办事项，每种任务仅保留一条",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

// 4. 解析 DSML 标签
function parseDsmlCalls(content: string) {
  const calls: { name: string; args: any }[] = [];
  const invokeRegex = /<｜｜DSML｜｜\s*invoke\s+name="([^"]+)">(.*?)<\/｜｜DSML｜｜\s*invoke>/gs;
  let match;
  while ((match = invokeRegex.exec(content)) !== null) {
    const name = match[1];
    const paramsBlock = match[2];
    const args: any = {};
    const paramRegex = /<｜｜DSML｜｜\s*parameter\s+name="([^"]+)"[^>]*>(.*?)<\/｜｜DSML｜｜\s*parameter>/gs;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
      const pName = paramMatch[1];
      const pVal = paramMatch[2].trim();
      args[pName] = pVal === "true" ? true : pVal === "false" ? false : pVal;
    }
    calls.push({ name, args });
  }
  return calls;
}

// 5. 智能体主入口
export async function reply(messages: ChatMessage[]): Promise<string> {
  try {
    if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY.includes("your_deepseek_api_key_here")) {
      return "⚠️ 尚未配置 DeepSeek API Key！请在项目根目录下的 .env 文件中设置 DEEPSEEK_API_KEY。";
    }

    const systemPrompt: OpenAI.ChatCompletionMessageParam = {
      role: "system",
      content: "你是一个贴心的待办事项助手小明。当用户表达记录、查询、完成、删除或清理重复待办请求时，你【必须】调用对应的工具操作数据库。请根据工具返回的结果亲切简洁地回答用户，严禁在回答中暴露代码标签。",
    };

    const formattedMessages: OpenAI.ChatCompletionMessageParam[] = [
      systemPrompt,
      ...messages.map((msg) => ({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      })),
    ];

    let response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: formattedMessages,
      tools: tools,
      tool_choice: "auto",
    });

    let responseMessage = response.choices?.[0]?.message;

    if (!responseMessage) {
      return "小明未能获取到有效的模型回复。";
    }

    let hasToolCalls = Boolean(responseMessage.tool_calls && responseMessage.tool_calls.length > 0);
    let dsmlCalls = parseDsmlCalls(responseMessage.content || "");

    while (hasToolCalls || dsmlCalls.length > 0) {
      if (hasToolCalls && responseMessage.tool_calls) {
        formattedMessages.push(responseMessage);
        for (const toolCall of responseMessage.tool_calls) {
          if (toolCall.type !== "function") continue;
          const functionName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments || "{}");
          const result = await executeTool(functionName, args);
          formattedMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
      } else if (dsmlCalls.length > 0) {
        for (const call of dsmlCalls) {
          const result = await executeTool(call.name, call.args);
          formattedMessages.push({
            role: "user",
            content: `系统提示：已执行工具 ${call.name}，返回结果为 ${JSON.stringify(result)}。请根据此结果用亲切中文回复用户！`,
          });
        }
      }

      response = await openai.chat.completions.create({
        model: "deepseek-chat",
        messages: formattedMessages,
      });

      responseMessage = response.choices?.[0]?.message;
      if (!responseMessage) break;

      hasToolCalls = Boolean(responseMessage.tool_calls && responseMessage.tool_calls.length > 0);
      dsmlCalls = parseDsmlCalls(responseMessage.content || "");
    }

    let finalContent = responseMessage?.content || "操作已完成。";
    finalContent = finalContent.replace(/<｜｜DSML｜｜[\s\S]*?<\/｜｜DSML｜｜\s*calls>/g, "").trim();

    return finalContent || "已经为你处理完成！";
  } catch (error: any) {
    console.error("智能体处理出错:", error);
    if (error?.status === 402 || error?.message?.includes("Insufficient Balance")) {
      return "⚠️ 无法回答：DeepSeek 账号余额不足（402 Insufficient Balance）。请前往 https://platform.deepseek.com 充值 1~2 元后重试。";
    }
    return `⚠️ 抱歉，小明遇到了一点问题：${error?.message || "未知错误"}`;
  }
}