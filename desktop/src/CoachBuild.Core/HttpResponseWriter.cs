using System.Net;
using System.Text;
using System.Text.Json;

namespace CoachBuild.Core;

public static class HttpResponseWriter
{
    public static void AddCorsHeaders(HttpListenerResponse response)
    {
        response.Headers["Access-Control-Allow-Origin"] = ComplianceRules.AllowedOrigin;
        response.Headers["Access-Control-Allow-Headers"] = ComplianceRules.AllowedHeaders;
        response.Headers["Access-Control-Allow-Methods"] = ComplianceRules.AllowedMethods;
        response.Headers["Access-Control-Max-Age"] = ComplianceRules.MaxAge;
    }

    public static async Task WriteJsonAsync(
        HttpListenerResponse response,
        int statusCode,
        object payload,
        CancellationToken cancellationToken = default)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload, payload.GetType(), JsonOptions.Wire);
        await WriteBytesAsync(response, statusCode, bytes, "application/json; charset=utf-8", cancellationToken)
            .ConfigureAwait(false);
    }

    public static Task WriteJsonElementAsync(
        HttpListenerResponse response,
        int statusCode,
        JsonElement payload,
        CancellationToken cancellationToken = default)
    {
        var bytes = Encoding.UTF8.GetBytes(payload.GetRawText());
        return WriteBytesAsync(response, statusCode, bytes, "application/json; charset=utf-8", cancellationToken);
    }

    public static async Task WriteNoContentAsync(
        HttpListenerResponse response,
        CancellationToken cancellationToken = default)
    {
        AddCorsHeaders(response);
        response.StatusCode = (int)HttpStatusCode.NoContent;
        response.ContentLength64 = 0;
        response.Close();
        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async Task WriteBytesAsync(
        HttpListenerResponse response,
        int statusCode,
        byte[] bytes,
        string contentType,
        CancellationToken cancellationToken)
    {
        AddCorsHeaders(response);
        response.StatusCode = statusCode;
        response.ContentType = contentType;
        response.ContentLength64 = bytes.Length;
        try
        {
            await response.OutputStream.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // The browser may have gone away; closing the response is enough.
        }
        finally
        {
            response.Close();
        }
    }
}

