<template>
  <main class="main-content">
    <div class="card">
      <div class="card-header bg-success-bright">
        <h5 class="pull-right">فاکتور خرید جدید</h5>
      </div>
      <div class="card-body">
        <div class="row">
          <div class="col-6">
            <div :class="['form-group', access?'':'hide']">
              <label class="col-form-label">نام مشتری:</label>
              <select id="AccountName" data-module="select2" name="AccountName"></select>
            </div>
            <div :class="['form-group', access?'hide':'']">
              <label class="col-form-label">نام مشتری:</label>
              <select id="l-AccountName" data-module="select2">
                <template v-if="accessData">
                  <option :value="accessData.AccountNumber">{{accessData.AccountName}}</option>
                  <option v-for="exAcc of accessData.ExAccounts" :value="exAcc.AccountNumber">{{ exAcc.AccountName }}</option>
                </template>
              </select>
            </div>

            <div class="form-group">
              <label class="col-form-label">کد مشتری:</label>
              <input v-if="access" type="text" class="form-control" readonly name="AccountNumber">
              <input v-else type="text" class="form-control" readonly name="AccountNumber">
            </div>
          </div>
          <div class="col-6">
            <div :class="['form-group', access?'':'hide']">
              <label class="col-form-label">نام نماینده فروش:</label>
              <select id="SAccountName" data-module="select2" name="SAccountName"></select>
            </div>
<!--            <div :class="['form-group', access?'hide':'']">-->
<!--      s        <label class="col-form-label">نام نماینده فروش:</label>-->
<!--              <select id="l-SAccountName" data-module="select2" readonly>-->
<!--                <template v-if="accessData">-->
<!--                  <option :value="accessData.SAccountNumber">{{accessData.SAccountName}}</option>-->
<!--                </template>-->
<!--              </select>-->
<!--            </div>-->
            <div :class="['form-group', access?'hide':'']">
              <label class="col-form-label">نام نماینده فروش:</label>
              <input v-if="accessData" type="text" class="form-control" :value="accessData.SAccountName" readonly>
            </div>

            <div class="form-group">
              <label class="col-form-label">کد نماینده فروش:</label>
              <input v-if="access" type="text" class="form-control" readonly name="SAccountNumber">
              <input v-else-if="accessData" type="text" class="form-control" readonly name="SAccountNumber" :value="accessData.SAccountNumber">
            </div>
          </div>
        </div>
<!--        <template v-if="access || accessData">-->
<!--          <div v-if="!access" class="row">-->
<!--            <div class="col-6">-->
<!--              <div class="form-group">-->
<!--                <label class="col-form-label">نام مشتری:</label>-->
<!--                <label class="mr-2">{{ accessData.AccountName }}</label>-->
<!--              </div>-->
<!--            </div>-->
<!--            <div class="col-6">-->
<!--              <div class="form-group">-->
<!--                <label class="col-form-label">نام نماینده فروش:</label>-->
<!--                <label class="mr-2">{{ accessData.SAccountName }}</label>-->
<!--              </div>-->
<!--            </div>-->
<!--          </div>-->
<!--        </template>-->
        <hr>

        <div class="row">
          <div class="col-6">
            <div class="form-group">
              <label class="col-form-label">رفرنس:</label>
              <input type="text" class="form-control" name="GeneralRef">
            </div>
          </div>

          <div class="col-6">
            <div class="form-group">
              <label class="col-form-label">توضیحات:</label>
              <input type="text" class="form-control" name="InvDescription">
            </div>
          </div>
        </div>

      </div>
      <div class="card-footer text-muted m-0">
        <div class="d-flex justify-content-end">
          <button class="btn btn-success" id="addToBody" data-toggle="modal" data-index="-1" data-target="#invoiceBody">افزودن ردیف جدید</button>
        </div>
      </div>

      <hr class="m-0">

      <div class="card-body p-0">
        <div class="table-responsive">
          <table class="table table-hover">
            <thead>
            <tr>
              <th width="55">ردیف</th>
              <th width="55">انبار</th>
              <th width="100">کد کالا</th>
              <th>نام کالا</th>
              <th width="55">مقدار</th>
              <th width="80">فی</th>
              <th width="80">مبلغ</th>
              <th></th>
            </tr>
            </thead>
            <tbody>
            <tr v-if="!invoiceBody.length">
              <td colspan="8" class="text-center text-muted">--- هیچ ردیفی برای فاکتور وارد نشده است ---</td>
            </tr>
            <tr v-else v-for="(item, index) of invoiceBody">
              <td>{{ index+1 }}</td>
              <td>{{ item.STNumber }}</td>
              <td class="font-en">{{ item.ItemNumber }}</td>
              <td class="font-en">{{ item.ItemName }}</td>
              <td>{{ item.Quan }}</td>
              <td>{{ number_format( item.Price ) }}</td>
              <td>{{ number_format( item.Price * item.Quan ) }}</td>
              <td class="text-left">
                <button @click="deleteItem(index)" class="btn btn-danger btn-xs ml-1"><i class="fa fa-trash"></i></button>
                <button data-toggle="modal" :data-index="index" data-target="#invoiceBody" class="btn btn-success btn-xs">ویرایش</button>
              </td>
            </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card-footer text-muted">
        <div class="d-flex justify-content-between">
          <div>هزینه: <span>0</span> ریال</div>
          <div>تخفیف: <span>0</span> ریال</div>
          <div>جمع کل: <span>{{ number_format(totalPrice) }}</span> ریال</div>
        </div>
      </div>
    </div>
    <div class="row mb-4">
      <div class="col-lg-12">
        <button @click="insertInvoice" class="btn btn-info" id="saveInvoice">ثبت نهایی فاکتور</button>
      </div>
    </div>
    <div v-if="!(access || accessData)" class="card">
      <div class="card-body">
        <div class="alert alert-danger alert-with-border m-b-0" role="alert">
          <h4 class="alert-heading">خطا!</h4>
          <p>متاسفانه در سیستم دسترسی ثبت فاکتور برای شما تعریف نگردیده است. لطفا با آقای رحمانی تماس حاصل فرمایید.</p>
        </div>
      </div>
    </div>

    <div class="modal fade" id="invoiceBody" tabindex="-1" role="dialog" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered" role="document">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">افزودن ردیف جدید</h5>
            <button type="button" class="close" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="col-form-label">نام کالا:</label>
              <select id="ItemDesc" name="ItemDesc" data-module="select2"></select>
            </div>
            <div class="form-group">
              <label class="col-form-label">کد کالا:</label>
              <input name="ItemNumber" type="text" readonly class="form-control">
            </div>
            <div class="form-group">
              <label class="col-form-label">انبار:</label>
              <select id="STNumber" name="STNumber" data-module="select2">
                <option value="">[ انتخاب کنید ]</option>
                <option value="1">01 - مركزي اصلي</option>
                <option value="20">20 - انبار 119</option>
                <option value="62">62 - انبار كنسول</option>
                <option value="35">70 - قطعه پالاديوم</option>
              </select>
            </div>
            <div class="form-group">
              <label class="col-form-label">تعداد:</label>
              <input name="Quan" type="number" class="form-control" value="1" min="1">
            </div>
            <div class="form-group">
              <label class="col-form-label">قیمت:</label>
              <input name="Price" type="text" data-input-mask="money" placeholder="0" dir="ltr" class="form-control text-right">
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-dismiss="modal">بی‌خیال</button>
            <button @click="addItem" type="button" class="btn btn-primary">ثبت</button>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>

<script>
import util from '../../assets/pureFunctions';
import axios from "axios";
export default {
  data(){
    return {
      access: false,
      accessData: null,
      invoiceBody: [],
      stocks: [],
      number_format: util.number_format,
      totalPrice: 0,
      activeIndex: -1,
      invType: "buy"
    }
  },
  methods: {
    addItem(){
      let ItemDesc = $("#ItemDesc").val();
      let ItemNumber = $("[name=ItemNumber]").val();
      let STNumber = $("#STNumber").val();
      let Quan = $("[name=Quan]").val();
      let Price = $("[name=Price]").val();
      if( !ItemDesc ) return toastr['error']("نام کالا وارد نشده است");
      if( !ItemNumber ) return toastr['error']("خطا در دریافت کد کالا");
      if( !STNumber ) return toastr['error']("انبار انتخاب نشده است");
      if( Quan <= 0 ) return toastr['error']("تعداد کالا کمتر از حد مجاز است");
      if( Price <= 10 ) return toastr['error']("مبلغ نا معتبر");

      const item = {
        STNumber: $("#STNumber").val(),
        ItemNumber: $("[name=ItemNumber]").val(),
        ItemName: $("#ItemDesc").text(),
        Quan: $("[name=Quan]").val(),
        Price: $("[name=Price]").val().replace(/,/g, "")
      };
      if( this.activeIndex == -1 ){
        this.invoiceBody.push(item);
      }else{
        this.invoiceBody[this.activeIndex] = item;
      }

      $("#invoiceBody").modal('hide');

      this.clearModal();
      this.calcInvoiceParams();
    },
    deleteItem(index){
      this.invoiceBody.splice(index, 1);
      this.calcInvoiceParams();
    },
    stockOnModalSync(stId){
      $("[name=ItemNumber]").val(stId);
      axios.post("https://shygun.4mk.ir/api/stock/search", {name: stId}).then(response => {
        if( response.data && response.data.ok ){
          this.stocks = response.data.list;
        }else{
          toastr['error']("خطایی در انجام عملیات رخ داده است.");
        }
      });
    },
    getAccessData(){
      axios.post('/admin/accounting/accAccessList', {user: 1}).then(({data}) => {
        if( data.ok ){
          this.accessData = data.list.length > 0 ? data.list[0] : null;
          $("[name=AccountNumber]").val(this.accessData.AccountNumber);
        }else{
          toastr['error']("خطا در خواندن سطح دسترسی.");
        }
      });
    },
    calcInvoiceParams(){
      this.totalPrice = 0;
      for(let item of this.invoiceBody){
        this.totalPrice += (item.Price * item.Quan);
      }
    },
    clearModal(){
      $("[name=ItemNumber]").val('');
      $("#ItemDesc").empty();
      $("[name=Quan]").val('1');
      $("[name=Price]").val('');
      this.stocks = [];
    },
    clearForm(){
      $("[name=AccountNumber]").val('');
      $("[name=SAccountNumber]").val('');
      $("#AccountName").empty();
      $("#SAccountName").empty();
      $("[name=GeneralRef]").val('');
      $("[name=InvDescription]").val('');
      this.invoiceBody = [];
    },
    insertInvoice(){
      let AccountNumber = $("[name=AccountNumber]").val();

      if( !AccountNumber ){
        toastr['error']("انتخاب نام مشتری الزامی است.");
        return null;
      }
      if( !this.invoiceBody.length  ){
        toastr['error']("هیچ ردیفی برای فاکتور درج نشده است.");
        return null;
      }

      let invoices = [];
      for( let item of this.invoiceBody ){
        invoices.push({
          STNumber: item.STNumber,
          ItemNumber: item.ItemNumber,
          Quan: item.Quan,
          Price: item.Price
        });
      }
      axios.post('/admin/accounting/putInvoice', {
        Body: invoices,
        InvTyp: 3,
        InvDescription: $("[name=InvDescription]").val(),
        InvDate: new Date().echo("Ymd"),
        InvPayDue: new Date().echo("Ymd"),
        AccountNumber: $("[name=AccountNumber]").val(),
        SAccountNumber: $("[name=SAccountNumber]").val(),
        DiscAmount: 0,
        GeneralRef: $("[name=GeneralRef]").val()
      }).then(({data}) => {
        if( data.ok ){
          toastr['success'](data.msg);
          this.clearModal();
          this.clearForm();
        }else{
          toastr['error'](data.error);
        }
      });
    }
  },
  created() {
    axios.post('/admin/access', {rule: "#createInvBuy;"}).then(({data}) => {
      if( data.ok ){
        this.access = data.access;
      }
    })
  },
  mounted() {
    const vm = this;
    this.getAccessData();
    $(document).ready(function(){
      $('#AccountName').select2({
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/customerName/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term
            };
          },
          processResults: function (data) {
            if( data.ok ){
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.AccountName,
                    id: item.AccountNumber,
                    scode: item.Scode1
                  }
                })
              };
            }else{
              return {
                results: []
              };
            }
          }
        }
      });

      $('#AccountName').on('select2:select', function (e) {
        var data = e.params.data;
        $("[name=AccountNumber]").val(data.id);
        if( vm.invType == "sale" ){
          axios.post('https://shygun.4mk.ir/api/customerName/search', {name: `:${data.scode}`}).then(({data}) => {
            if( data && data.ok ){
              $("#SAccountName").empty();
              $('#SAccountName').append( new Option(data.list[0].AccountName, data.list[0].AccountNumber, false, false) ).trigger('change');
              $("[name=SAccountNumber]").val(data.list[0].AccountNumber);
            }
          });
        }
      });

      $('#l-AccountName').on('select2:select', function (e) {
        var data = e.params.data;
        $("[name=AccountNumber]").val(data.id);
      });

      $('#SAccountName').select2({
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/customerName/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term
            };
          },
          processResults: function (data) {
            if( data.ok ){
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.AccountName,
                    id: item.AccountNumber
                  }
                })
              };
            }else{
              return {
                results: []
              };
            }
          }
        }
      });

      $('#SAccountName').on('select2:select', function (e) {
        var data = e.params.data;
        $("[name=SAccountNumber]").val(data.id);
      });

      $('#ItemDesc').select2({
        placeholder: "قسمتی از نام کالا را وارد کنید ...",
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/productName/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term
            };
          },
          processResults: function (data) {
            if( data.ok ){
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.ItemDesc,
                    id: item.ItemCode
                  }
                })
              };
            }else{
              return {
                results: []
              };
            }
          }
        }
      });

      $('#ItemDesc').on('select2:select', function (e) {
        var data = e.params.data;
        vm.stockOnModalSync(data.id);
      });

      $('#invoiceBody').on('show.bs.modal', function (event) {
        var el = $(event.relatedTarget), modal = $(this), i = el.data('index');
        vm.activeIndex = i;
        vm.clearModal();
        if( i == -1 ){
          modal.find('.modal-title').text("افزودن ردیف جدید");
        }else{
          modal.find('.modal-title').text("ویرایش ردیف");

          $('#ItemDesc').append( new Option(vm.invoiceBody[i].ItemName, vm.invoiceBody[i].ItemNumber, false, false) ).trigger('change');
          vm.stockOnModalSync(vm.invoiceBody[i].ItemNumber);
          $("[name=Quan]").val(vm.invoiceBody[i].Quan);
          $("[name=Price]").val(vm.number_format(vm.invoiceBody[i].Price));
        }
      });

      $('[data-input-mask="money"]').mask('000,000,000,000,000', {reverse: true});

    });
  }
}
</script>

<style scoped>
.btn-xs {
  padding: 2px 5px;
  font-size: 11px;
  height: 21px;
}
.font-en{
  font-family: Sans-Serif, Tahoma, Arial;
}
.hide{display: none}
</style>
