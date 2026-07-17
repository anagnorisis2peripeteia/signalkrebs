using System.Threading.Tasks;
// CLEAN: awaits properly — no sync-over-async, guards against a false positive.
public class Fixture {
  Task<int> FetchAsync() => Task.FromResult(1);
  public async Task<int> Clean() => await FetchAsync();
}
