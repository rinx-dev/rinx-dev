import type { APIRoute } from "astro";

export const GET: APIRoute = ({ params, request }) => {
  let reqHeaders: Record<string, string>[] = [];

  request.headers.forEach((value, key) => {
    reqHeaders.push({
      key,
      value,
    });
  });

  return new Response(
    JSON.stringify({
      message: "This was a GET!",
      reqHeaders,
    })
  );
};

export const POST: APIRoute = ({ request }) => {
  return new Response(
    JSON.stringify({
      message: "This was a POST!",
    })
  );
};

export const DELETE: APIRoute = ({ request }) => {
  return new Response(
    JSON.stringify({
      message: "This was a DELETE!",
    })
  );
};
``;

export const ALL: APIRoute = ({ request }) => {
  return new Response(
    JSON.stringify({
      message: `This was a ${request.method}!`,
    })
  );
};
