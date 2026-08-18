using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DirectXfer.WindowsServerHost
{
    internal sealed class JsonCompat
    {
        private static readonly JsonSerializerOptions ReadOptions = CreateReadOptions();
        private static readonly JsonSerializerOptions WriteOptions = new()
        {
            IncludeFields = true,
            PropertyNameCaseInsensitive = true,
            WriteIndented = false
        };

        private static JsonSerializerOptions CreateReadOptions()
        {
            JsonSerializerOptions options = new()
            {
                IncludeFields = true,
                PropertyNameCaseInsensitive = true,
                WriteIndented = false
            };
            options.Converters.Add(new InferredObjectConverter());
            return options;
        }

        internal T? Deserialize<T>(string json)
            => JsonSerializer.Deserialize<T>(json, ReadOptions);

        internal string Serialize<T>(T value)
            => JsonSerializer.Serialize(value, WriteOptions);

        private sealed class InferredObjectConverter : JsonConverter<object>
        {
            public override object? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
            {
                using var doc = JsonDocument.ParseValue(ref reader);
                return ConvertElement(doc.RootElement);
            }

            private static object? ConvertElement(JsonElement element)
            {
                switch (element.ValueKind)
                {
                    case JsonValueKind.Object:
                        Dictionary<string, object?> dict = new(StringComparer.Ordinal);
                        foreach (var property in element.EnumerateObject())
                            dict[property.Name] = ConvertElement(property.Value);
                        return dict;
                    case JsonValueKind.Array:
                        List<object?> list = new();
                        foreach (var item in element.EnumerateArray())
                            list.Add(ConvertElement(item));
                        return list;
                    case JsonValueKind.String:
                        return element.GetString();
                    case JsonValueKind.Number:
                        if (element.TryGetInt64(out var integer)) return integer;
                        if (element.TryGetDecimal(out var decimalValue)) return decimalValue;
                        return element.GetDouble();
                    case JsonValueKind.True:
                        return true;
                    case JsonValueKind.False:
                        return false;
                    case JsonValueKind.Null:
                    case JsonValueKind.Undefined:
                    default:
                        return null;
                }
            }

            public override void Write(Utf8JsonWriter writer, object? value, JsonSerializerOptions options)
            {
                if (value is null)
                {
                    writer.WriteNullValue();
                    return;
                }
                JsonSerializer.Serialize(writer, value, value.GetType(), WriteOptions);
            }
        }
    }
}
