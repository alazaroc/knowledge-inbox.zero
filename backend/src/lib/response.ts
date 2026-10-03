import type { APIGatewayProxyResult } from 'aws-lambda';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.FRONTEND_URL ?? '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Content-Type': 'application/json',
};

export const ok = (body: unknown): APIGatewayProxyResult => ({
  statusCode: 200,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

export const created = (body: unknown): APIGatewayProxyResult => ({
  statusCode: 201,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

export const noContent = (): APIGatewayProxyResult => ({
  statusCode: 204,
  headers: CORS_HEADERS,
  body: '',
});

export const badRequest = (message: string): APIGatewayProxyResult => ({
  statusCode: 400,
  headers: CORS_HEADERS,
  body: JSON.stringify({ message }),
});

export const unauthorized = (): APIGatewayProxyResult => ({
  statusCode: 401,
  headers: CORS_HEADERS,
  body: JSON.stringify({ message: 'Unauthorized' }),
});

export const forbidden = (): APIGatewayProxyResult => ({
  statusCode: 403,
  headers: CORS_HEADERS,
  body: JSON.stringify({ message: 'Forbidden' }),
});

export const notFound = (resource = 'Resource'): APIGatewayProxyResult => ({
  statusCode: 404,
  headers: CORS_HEADERS,
  body: JSON.stringify({ message: `${resource} not found` }),
});

export const conflict = (message: string): APIGatewayProxyResult => ({
  statusCode: 409,
  headers: CORS_HEADERS,
  body: JSON.stringify({ message }),
});

export const serverError = (err: unknown): APIGatewayProxyResult => {
  // Structured error log with stack for diagnosis in CloudWatch.
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(
    JSON.stringify({
      level: 'error',
      type: 'unhandled',
      message: msg,
      name: err instanceof Error ? err.name : undefined,
      stack,
    })
  );
  return {
    statusCode: 500,
    headers: CORS_HEADERS,
    body: JSON.stringify({ message: 'Internal server error' }),
  };
};
